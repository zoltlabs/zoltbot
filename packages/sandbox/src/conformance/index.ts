import type { ExecutionTarget, SandboxRef, SandboxSpec } from "../interface.js";
import { SandboxError } from "../interface.js";
import { collect } from "../stream.js";

// Every execution target passes these scenarios before it ships (I12). Each scenario creates the
// sandboxes it needs and destroys them, so scenarios are independent and can run in any order.

export const scenarios = [
  "lifecycle",
  "exec_output",
  "exec_streaming",
  "exec_env_cwd",
  "exec_kill",
  "exec_missing",
  "files",
  "files_exec",
  "ports",
  "sleep_wake",
  "snapshot",
  "sizing",
] as const;
export type Scenario = (typeof scenarios)[number];

export interface ConformanceOptions {
  /** Base spec for every sandbox, such as a template the target can boot quickly. */
  spec?: SandboxSpec;
  /** Command that serves `zolt-port-ok` over HTTP on the port. Defaults to Node. */
  server?: (port: number) => string[];
  /** Multiplies waits for slow remote targets. */
  slow?: number;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Conformance failure: ${message}`);
}

async function rejects(work: () => Promise<unknown>, code: SandboxError["code"], what: string) {
  try {
    await work();
  } catch (error) {
    check(
      error instanceof SandboxError && error.code === code,
      `${what} should fail with ${code}, got ${String(error)}`,
    );
    return;
  }
  throw new Error(`Conformance failure: ${what} should fail with ${code}`);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nodeServer =
  "require('node:http').createServer((q,s)=>s.end('zolt-port-ok')).listen(Number(process.argv[1]),'0.0.0.0')";
const pythonServer = [
  "import sys, http.server as h",
  "class H(h.BaseHTTPRequestHandler):",
  "  def do_GET(s):",
  "    s.send_response(200); s.end_headers(); s.wfile.write(b'zolt-port-ok')",
  "h.HTTPServer(('0.0.0.0', int(sys.argv[1])), H).serve_forever()",
].join("\n");
// Templates differ in which runtime they ship, so the server uses Node and falls back to Python.
const defaultServer = (port: number) => [
  "sh",
  "-c",
  'if command -v node >/dev/null 2>&1; then exec node -e "$0" "$1"; else exec python3 -c "$2" "$1"; fi',
  nodeServer,
  String(port),
  pythonServer,
];

async function run(target: ExecutionTarget, ref: SandboxRef, script: string) {
  return collect(await target.exec(ref, ["sh", "-c", script]));
}

export async function runConformance(
  target: ExecutionTarget,
  scenario: Scenario,
  options: ConformanceOptions = {},
) {
  const slow = options.slow ?? 1;
  const caps = target.capabilities;
  const created: SandboxRef[] = [];
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  async function create(spec: SandboxSpec = {}) {
    const ref = await target.create({
      ...options.spec,
      ...spec,
      env: { ...options.spec?.env, ...spec.env },
      ...(caps.ports === "declared" ? { ports: [port] } : {}),
    });
    created.push(ref);
    check(ref.target === target.id, "ref names its target");
    check(ref.workdir.startsWith("/"), "workdir is absolute");
    return ref;
  }

  try {
    switch (scenario) {
      case "lifecycle": {
        const ref = await create();
        check((await target.status(ref)).state === "running", "new sandbox is running");
        await target.destroy(ref);
        check((await target.status(ref)).state === "destroyed", "destroyed sandbox reports it");
        await rejects(() => target.exec(ref, ["true"]), "gone", "exec after destroy");
        await target.destroy(ref);
        break;
      }
      case "exec_output": {
        const ref = await create();
        const result = await run(target, ref, "printf out; printf err >&2; exit 3");
        check(result.stdout === "out", `stdout separated, got ${JSON.stringify(result.stdout)}`);
        check(result.stderr === "err", `stderr separated, got ${JSON.stringify(result.stderr)}`);
        check(result.code === 3, `exit code kept, got ${result.code}`);
        const ok = await collect(await target.exec(ref, ["echo", "a b", "c'd"]));
        check(ok.stdout === "a b c'd\n" && ok.code === 0, "argv is passed without reparsing");
        break;
      }
      case "exec_streaming": {
        const ref = await create();
        const started = Date.now();
        const process = await target.exec(ref, ["sh", "-c", "echo first; sleep 3; echo second"]);
        let settled = false;
        void process.exit.then(() => {
          settled = true;
        });
        const iterator = process[Symbol.asyncIterator]();
        const first = await iterator.next();
        check(!first.done && first.value.data.startsWith("first"), "first chunk arrives");
        check(!settled, "first chunk arrives before the process exits");
        check(Date.now() - started < 2_500 * slow, "first chunk is not held until exit");
        let rest = "";
        for (let next = await iterator.next(); !next.done; next = await iterator.next())
          rest += next.value.data;
        check(rest.includes("second"), "later chunks arrive");
        check((await process.exit).code === 0, "streamed process exits cleanly");
        break;
      }
      case "exec_env_cwd": {
        const ref = await create({ env: { ZOLT_CREATE: "from create" } });
        await target.files.write(ref, "sub/.keep", "");
        const result = await collect(
          await target.exec(
            ref,
            ["sh", "-c", 'printf "%s|%s|%s" "$ZOLT_CREATE" "$ZOLT_EXEC" "$(pwd)"'],
            {
              cwd: `${ref.workdir}/sub`,
              env: { ZOLT_EXEC: "from exec" },
            },
          ),
        );
        check(
          result.stdout === `from create|from exec|${ref.workdir}/sub`,
          `env and cwd apply, got ${JSON.stringify(result.stdout)}`,
        );
        const home = await run(target, ref, "pwd");
        check(home.stdout.trim() === ref.workdir, "default cwd is the workdir");
        break;
      }
      case "exec_kill": {
        const ref = await create();
        const process = await target.exec(ref, ["sleep", "60"]);
        await pause(300 * slow);
        const started = Date.now();
        await process.kill();
        const exit = await process.exit;
        check(exit.killed === true, "kill is reported");
        check(Date.now() - started < 5_000 * slow, "kill ends the process promptly");
        await process.kill();
        break;
      }
      case "exec_missing": {
        const ref = await create();
        const result = await collect(await target.exec(ref, ["zolt-no-such-command"]));
        check(result.code === 127, `missing command exits 127, got ${result.code}`);
        break;
      }
      case "files": {
        const ref = await create();
        const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
        await target.files.write(ref, "deep/nested/bytes.bin", bytes);
        await target.files.write(ref, `${ref.workdir}/deep/note.txt`, "hello sandbox\n");
        const back = await target.files.read(ref, `${ref.workdir}/deep/nested/bytes.bin`);
        check(back.length === 256 && back.every((b, i) => b === i), "binary content round trips");
        check(
          text(await target.files.read(ref, "deep/note.txt")) === "hello sandbox\n",
          "text round trips",
        );
        const entries = await target.files.list(ref, "deep");
        const note = entries.find((entry) => entry.name === "note.txt");
        const nested = entries.find((entry) => entry.name === "nested");
        check(note?.type === "file" && note.size === 14, "list reports files with size");
        check(note.path === `${ref.workdir}/deep/note.txt`, "list reports absolute paths");
        check(nested?.type === "dir", "list reports directories");
        check(entries.length === 2, "list is not recursive");
        await rejects(
          () => target.files.read(ref, "absent.txt"),
          "not_found",
          "read of missing file",
        );
        await rejects(
          () => target.files.list(ref, "absent"),
          "not_found",
          "list of missing folder",
        );
        await target.files.write(ref, "deep/note.txt", "replaced");
        check(text(await target.files.read(ref, "deep/note.txt")) === "replaced", "write replaces");
        break;
      }
      case "files_exec": {
        const ref = await create();
        await target.files.write(ref, "input.txt", "from files");
        const read = await run(target, ref, "cat input.txt; printf 'from exec' > output.txt");
        check(read.stdout === "from files", "exec sees files written through the API");
        check(
          text(await target.files.read(ref, "output.txt")) === "from exec",
          "API sees exec output",
        );
        break;
      }
      case "ports": {
        const ref = await create();
        const server = await target.exec(ref, (options.server ?? defaultServer)(port));
        const url = await target.ports.expose(ref, port);
        check(/^https?:\/\//.test(url), "expose returns a URL");
        let body = "";
        const deadline = Date.now() + 15_000 * slow;
        while (Date.now() < deadline && body !== "zolt-port-ok") {
          body = await fetch(url, { signal: AbortSignal.timeout(2_000 * slow) })
            .then((response) => response.text())
            .catch(() => "");
          if (body !== "zolt-port-ok") await pause(200);
        }
        check(body === "zolt-port-ok", "exposed port reaches the sandbox server");
        await server.kill();
        if (caps.ports === "declared")
          await rejects(() => target.ports.expose(ref, port + 1), "unsupported", "undeclared port");
        break;
      }
      case "sleep_wake": {
        const ref = await create();
        await target.files.write(ref, "kept.txt", "survives sleep");
        const background = await run(target, ref, "sleep 600 >/dev/null 2>&1 & echo $!");
        const pid = background.stdout.trim();
        check(/^\d+$/.test(pid), "background process starts");
        await target.sleep(ref);
        check((await target.status(ref)).state === "sleeping", "slept sandbox reports sleeping");
        await target.sleep(ref);
        await target.wake(ref);
        check((await target.status(ref)).state === "running", "woken sandbox reports running");
        await target.wake(ref);
        check(text(await target.files.read(ref, "kept.txt")) === "survives sleep", "files survive");
        if (caps.sleepKeepsProcesses) {
          const alive = await run(target, ref, `kill -0 ${pid}`);
          check(alive.code === 0, "processes survive sleep when the target declares it");
        }
        break;
      }
      case "snapshot": {
        const ref = await create();
        if (!caps.snapshot) {
          await rejects(() => target.snapshot(ref), "unsupported", "snapshot without capability");
          break;
        }
        await target.files.write(ref, "state/kept.txt", "in the snapshot");
        const snapshot = await target.snapshot(ref);
        check(snapshot.target === target.id && snapshot.id, "snapshot ref is returned");
        await target.files.write(ref, "state/kept.txt", "changed after");
        const copy = await create({ from: snapshot });
        check(copy.id !== ref.id, "a snapshot starts a new sandbox");
        const kept = text(await target.files.read(copy, "state/kept.txt"));
        check(kept === "in the snapshot", `snapshot keeps files, got ${JSON.stringify(kept)}`);
        break;
      }
      case "sizing": {
        const size = { cpus: 1, memoryMiB: 512 };
        if (caps.sizing === "per_sandbox") {
          const ref = await create({ size });
          check((await run(target, ref, "true")).code === 0, "sized sandbox runs");
        } else {
          await rejects(() => create({ size }), "unsupported", "size on a template-sized target");
        }
        break;
      }
    }
  } finally {
    for (const ref of created) await target.destroy(ref).catch(() => undefined);
  }
}
