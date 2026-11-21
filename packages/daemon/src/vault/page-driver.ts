// V2: how the daemon types a vault value into the agent's browser. Checks and typing run as
// Playwright code in the browser's own Node process, so the page's scripts can't fake the address
// or the frame a field is in. The code reaches the browser CLI on stdin, never in a command line
// (which any local process can list), and the CLI's output is never returned to the agent or
// written to a log.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { type BrowserBinding, browserEnvironment, cliPath } from "../browser/runtime.js";

/** The page operations a fill needs. B2's engine can provide the same over CDP. */
export interface PageDriver {
  /**
   * The `type` of the element a snapshot ref or selector names ("password", "text", …) and the
   * address of the frame it is in, so a field inside another site's frame doesn't pass.
   */
  field(target: string): Promise<{ type: string; url: string }>;
  /**
   * Types each value into its field, then presses Enter in the last one when `submit` is set.
   * Checks again, in the same step, that every field still has an allowed type and sits in a
   * frame on `origin` (scheme and host); nothing is typed if one doesn't.
   */
  fill(
    fields: { target: string; value: string; types: readonly string[] }[],
    origin: string,
    submit: boolean,
  ): Promise<void>;
}

// Reads the CLI arguments from stdin, so none of them is visible in the process list.
const RUNNER = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{input+=c;if(input.length>65536)process.exit(1)});process.stdin.on('end',()=>{const {cli,args}=JSON.parse(input);process.argv=[process.argv[0],cli,...args];require(cli)})`;

function run(binding: BrowserBinding, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", RUNNER], {
      cwd: binding.artifactRoot,
      env: browserEnvironment(binding),
      stdio: ["pipe", "pipe", "ignore"],
    });
    const output: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 262_144) child.kill("SIGKILL");
      else output.push(chunk);
    });
    child.on("error", () => reject(new Error("browser_unavailable")));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
      else reject(new Error("browser_unavailable"));
    });
    child.stdin.end(JSON.stringify({ cli: cliPath(), args: [`-s=${binding.session}`, ...args] }));
  });
}

/** Finds the line that carries this call's marker; the page can't know it, so can't fake it. */
export function markedResult(output: string, marker: string): string | undefined {
  for (const line of output.split("\n")) {
    const text = line.trim();
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {}
    if (typeof value === "string" && value.startsWith(marker)) return value.slice(marker.length);
  }
  return undefined;
}

/** A snapshot ref ("e12", "f1e3") or a plain CSS selector; nothing that reads like an option. */
export function validTarget(target: string): boolean {
  return /^[^\s-][^\n]{0,499}$/.test(target);
}

const LOCATE = [
  "const locate = (target) => page.locator(/^(f\\d+)?e\\d+$/.test(target) ? 'aria-ref=' + target : target).elementHandle({ timeout: 5000 });",
  "const describe = (handle) => handle.evaluate((element) => element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase());",
].join("\n");

/** Playwright code for `run-code`: `body` runs with `page`, and its result follows the marker. */
function script(marker: string, body: string) {
  return `async (page) => {\n${LOCATE}\nconst step = async () => {\n${body}\n};\nreturn ${JSON.stringify(marker)} + (await step());\n}`;
}

/** The type of the field a target names and the address of its frame, as JSON. */
export function fieldScript(marker: string, target: string) {
  return script(
    marker,
    `const handle = await locate(${JSON.stringify(target)});\nconst frame = await handle.ownerFrame();\nreturn JSON.stringify([await describe(handle), frame ? frame.url() : ""]);`,
  );
}

/**
 * Checks every field again, then fetches the values once from `valuesUrl` and types them;
 * "filled", or "changed" with nothing fetched or typed. The values never appear in the code.
 */
export function fillScript(
  marker: string,
  fields: readonly { target: string; types: readonly string[] }[],
  origin: string,
  submit: boolean,
  valuesUrl: string,
) {
  return script(
    marker,
    [
      `const fields = ${JSON.stringify(fields)};`,
      "const handles = [];",
      "for (const field of fields) {",
      "  const handle = await locate(field.target);",
      "  const frame = await handle.ownerFrame();",
      "  let frameOrigin = '';",
      "  try { frameOrigin = new URL(frame ? frame.url() : '').origin; } catch {}",
      `  if (frameOrigin !== ${JSON.stringify(origin)} || !field.types.includes(await describe(handle))) return 'changed';`,
      "  handles.push(handle);",
      "}",
      `const values = await (await fetch(${JSON.stringify(valuesUrl)})).json();`,
      "for (let i = 0; i < handles.length; i++) await handles[i].fill(values[i]);",
      `if (${submit ? "true" : "false"}) await handles[handles.length - 1].press('Enter');`,
      "return 'filled';",
    ].join("\n"),
  );
}

/** Serves `values` once, on this Mac only, at an address nobody can guess. */
export async function handOver(values: readonly string[]) {
  const token = randomBytes(32).toString("hex");
  let served = false;
  const server = createServer((request, response) => {
    if (served || request.method !== "GET" || request.url !== `/${token}`) {
      response.writeHead(404).end();
      return;
    }
    served = true;
    response
      .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify(values));
    server.close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/${token}`,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

async function runScript(binding: BrowserBinding, build: (marker: string) => string) {
  const marker = `zb-vault:${randomUUID()}:`;
  const result = markedResult(await run(binding, ["run-code", build(marker)]), marker);
  if (result === undefined) throw new Error("browser_unavailable");
  return result;
}

export function browserPageDriver(binding: BrowserBinding): PageDriver {
  return {
    async field(target) {
      const parsed: unknown = JSON.parse(
        await runScript(binding, (marker) => fieldScript(marker, target)),
      );
      if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string")
        throw new Error("browser_unavailable");
      return { type: parsed[0], url: parsed[1] };
    },
    async fill(fields, origin, submit) {
      const values = await handOver(fields.map((field) => field.value));
      try {
        const result = await runScript(binding, (marker) =>
          fillScript(
            marker,
            fields.map(({ target, types }) => ({ target, types })),
            origin,
            submit,
            values.url,
          ),
        );
        if (result !== "filled") throw new Error("page_changed");
      } finally {
        values.close();
      }
    },
  };
}
