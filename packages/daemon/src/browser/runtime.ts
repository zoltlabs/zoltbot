import { redactBrowserText } from "./redaction.js";

export { redactBrowserText } from "./redaction.js";

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
export const CLI_VERSION = "0.1.23";

import type { BrowserBinding, BrowserSelection } from "@zoltbot/protocol";

export type { BrowserBinding, BrowserSelection } from "@zoltbot/protocol";

const execute = promisify(execFile);
export function cliPath() {
  return fileURLToPath(import.meta.resolve("@playwright/cli/playwright-cli.js"));
}
export function socketRoot(b: Pick<BrowserBinding, "home">) {
  return path.join(
    realpathSync("/tmp"),
    `zb-${createHash("sha256").update(b.home).digest("hex").slice(0, 16)}`,
  );
}
export function browserEnvironment(
  binding: Pick<BrowserBinding, "home" | "browsers">,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^(PLAYWRIGHT_|PWTEST_|NODE_OPTIONS$|NODE_PATH$|HOME$|TMPDIR$|XDG_)/.test(key))
      env[key] = value;
  return {
    ...env,
    HOME: binding.home,
    TMPDIR: path.join(binding.home, "tmp"),
    XDG_RUNTIME_DIR: socketRoot(binding),
    PLAYWRIGHT_BROWSERS_PATH: binding.browsers,
    NO_UPDATE_NOTIFIER: "1",
  };
}
export function validateBrowserArgs(args: string[]) {
  if (!args.length || args.length > 100 || args.some((a) => a.length > 16000))
    throw Error("invalid_browser_arguments");
  if (
    !/^[a-z][a-z-]*$/.test(args[0] ?? "") &&
    !(["--help", "--version"].includes(args[0] ?? "") && args.length === 1)
  )
    throw Error("browser_command_required_first");
  const denied = new Set([
    "attach",
    "detach",
    "close-all",
    "kill-all",
    "delete-data",
    "install",
    "install-browser",
    "show",
    "state-load",
    "state-save",
  ]);
  if (denied.has(args[0] ?? "")) throw Error("browser_command_not_task_scoped");
  for (const arg of args)
    if (
      (/^-[^-]/.test(arg) && !["-h", "-v"].includes(arg)) ||
      /^(-s|--(?:no-)?(?:session|config|profile|persistent|user-data-dir|storage-state|cdp|endpoint|extension|browser|executable-path|host|port|output-dir|headed)(?:=|$))/.test(
        arg,
      )
    )
      throw Error("browser_override_denied");
}
export function browserBinding(
  directory: string,
  cwd: string,
  selection: BrowserSelection,
): BrowserBinding {
  directory = realpathSync(directory);
  cwd = realpathSync(cwd);
  if (selection.url) {
    const url = new URL(selection.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error("browser_url_requires_plain_http_origin_or_path");
  }
  const id = randomUUID();
  const root = path.join(cwd, "output", "zoltbot-browser", id);
  const binding = {
    version: 1,
    id,
    session: `zb-${id}`,
    runtimeVersion: CLI_VERSION,
    launcher: path.join(directory, "browser", "launchers", id, "browser"),
    artifactRoot: root,
    cwd,
    home: path.join(root, "runtime"),
    browsers: path.join(directory, "browser", "browsers"),
    ...selection,
  };
  const guidanceText = renderBrowserGuidance(binding);
  return {
    ...binding,
    version: 1,
    guidanceText,
    guidanceHash: createHash("sha256").update(guidanceText).digest("hex"),
  };
}
export function browserGuidance(b: BrowserBinding) {
  if (createHash("sha256").update(b.guidanceText).digest("hex") !== b.guidanceHash)
    throw Error("browser_guidance_changed");
  return b.guidanceText;
}
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function renderBrowserGuidance(
  b: Omit<BrowserBinding, "guidanceText" | "guidanceHash" | "version"> & { version: number },
) {
  // Absolute paths are long and repeat across launches; name each folder once (fixed budget, I9).
  return `Browser verification (isolated local session, CLI ${b.runtimeVersion}). Run ${shellQuote(b.launcher)} open ${shellQuote(b.url ?? "about:blank")}, then snapshot before using refs, fill/click as needed, screenshot --filename=${shellQuote(path.join(b.artifactRoot, "capture.png"))}. Generated files go in that capture folder. Register the capture with team_browser_evidence using a path relative to it, URL, viewport and check outcome. Then inspect the returned canonicalPath with your native image tool, and report what the pixels show. Capture alone does not prove inspection. Checks are agent reports. Pause before human takeover. Shell approvals do not provide per-click security. If login or takeover is needed, ask the human through the existing question tool; unattended waits expire. Do not capture secrets, cookies or network bodies.`;
}
export function materializeBrowser(b: BrowserBinding) {
  if (b.runtimeVersion !== CLI_VERSION || b.version !== 1)
    throw Error("browser_version_unsupported");
  for (const dir of [
    path.dirname(b.launcher),
    b.artifactRoot,
    b.home,
    path.join(b.home, "tmp"),
    socketRoot(b),
  ]) {
    ownedDirectory(dir);
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
      throw Error("browser_directory_not_owned");
  }
  if (realpathSync(b.artifactRoot) !== path.resolve(b.artifactRoot))
    throw Error("browser_artifact_root_symlink_denied");
  const config = path.join(path.dirname(b.launcher), "config.json");
  const body = JSON.stringify({
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions: { headless: b.mode === "background", channel: "", chromiumSandbox: true },
    },
    outputDir: b.artifactRoot,
  });
  immutable(config, body);
  const source = `const {spawn}=await import('node:child_process');\nconst {writeFileSync,renameSync}=await import('node:fs');\nconst {randomUUID}=await import('node:crypto');\nconst args=process.argv.slice(2);\nconst validate=${validateBrowserArgs.toString()};\nconst redact=${redactBrowserText.toString()};\ntry{validate(args)}catch(e){console.error(e.message);process.exit(1)}\nconst env=Object.fromEntries(Object.entries(process.env).filter(([k])=>! /^(PLAYWRIGHT_|PWTEST_|NODE_OPTIONS$|NODE_PATH$|HOME$|TMPDIR$|XDG_)/.test(k)));\nObject.assign(env,${JSON.stringify({ HOME: b.home, TMPDIR: path.join(b.home, "tmp"), XDG_RUNTIME_DIR: socketRoot(b), PLAYWRIGHT_BROWSERS_PATH: b.browsers, NO_UPDATE_NOTIFIER: "1" })});\nconst extra=args[0]==='open'?[${JSON.stringify(`--config=${config}`)}]:[];\nif(args[0]==='open'){const target=${JSON.stringify(path.join(b.home, "generation.json"))};const temp=target+'.'+randomUUID();writeFileSync(temp,JSON.stringify({nonce:randomUUID(),at:new Date().toISOString()}),{flag:'wx',mode:0o600});renameSync(temp,target); }\nconst child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cliPath())},${JSON.stringify(`-s=${b.session}`)},...args,...extra],{cwd:${JSON.stringify(b.artifactRoot)},env,stdio:['inherit','pipe','pipe']});\nfor(const [input,output] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]){let text='';input.on('data',c=>{text+=c;if(text.length>1048576){child.kill();text='[browser output exceeded limit]'}});input.on('end',()=>output.write(redact(text)))}\nchild.on('error',()=>{console.error('browser_runtime_failed');process.exitCode=1});child.on('exit',code=>{process.exitCode=code??1});\n`;
  immutable(`${b.launcher}.mjs`, source, 0o400);
  immutable(
    b.launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(`${b.launcher}.mjs`)} "$@"\n`,
    0o500,
  );
}
function ownedDirectory(directory: string) {
  let cursor = path.parse(directory).root;
  for (const part of path.relative(cursor, directory).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error("browser_directory_not_owned");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(cursor, { mode: 0o700 });
    }
  }
}
function immutable(file: string, body: string, mode = 0o400) {
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())
      throw Error("browser_materialization_changed");
    if (readFileSync(file, "utf8") !== body) throw Error("browser_materialization_changed");
    return;
  }
  writeFileSync(file, body, { flag: "wx", mode });
}
export async function browserCommand(b: BrowserBinding, args: string[]) {
  materializeBrowser(b);
  validateBrowserArgs(args);
  const result = await execute(process.execPath, [`${b.launcher}.mjs`, ...args], {
    cwd: b.cwd,
    env: browserEnvironment(b),
    timeout: 45000,
    maxBuffer: 1048576,
  });
  return redactBrowserText(result.stdout);
}
export async function browserReadiness(directory: string) {
  try {
    const cli = cliPath();
    const metadata = JSON.parse(readFileSync(path.join(path.dirname(cli), "package.json"), "utf8"));
    if (metadata.version !== CLI_VERSION)
      return { state: "unsupported_version", version: String(metadata.version) };
    const browsers = path.join(directory, "browser", "browsers");
    const core = fileURLToPath(import.meta.resolve("@playwright/cli/package.json"));
    const { createRequire } = await import("node:module");
    const require = createRequire(core);
    // Resolve in a child: Playwright caches browser paths at module initialization.
    const script = `const p=require(${JSON.stringify(require.resolve("playwright-core"))});console.log(require('fs').existsSync(p.chromium.executablePath()));`;
    const probe = await execute(process.execPath, ["-e", script], {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
      timeout: 10000,
    });
    return {
      state: probe.stdout.trim() === "true" ? "ready" : "missing_browser",
      version: CLI_VERSION,
    };
  } catch (error) {
    return {
      state: ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(
        String((error as NodeJS.ErrnoException).code),
      )
        ? "not_installed"
        : "needs_repair",
      version: CLI_VERSION,
    };
  }
}
export async function setupBrowser(directory: string) {
  const { createRequire } = await import("node:module");
  const require = createRequire(cliPath());
  const core = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
  await execute(process.execPath, [core, "install", "chromium"], {
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: path.join(directory, "browser", "browsers"),
      NO_UPDATE_NOTIFIER: "1",
    },
    timeout: 300000,
    maxBuffer: 1048576,
  });
  const readiness = await browserReadiness(directory);
  if (readiness.state !== "ready") return readiness;
  const probeRoot = path.join(directory, "browser", "setup-probe");
  mkdirSync(probeRoot, { recursive: true, mode: 0o700 });
  const binding = browserBinding(directory, realpathSync(probeRoot), { mode: "background" });
  try {
    await browserCommand(binding, ["open", "about:blank"]);
    await browserCommand(binding, ["snapshot"]);
  } finally {
    await browserCommand(binding, ["close"]).catch(() => {});
  }
  return { ...readiness, navigationProbe: "passed" };
}
export const browserDigest = (b: BrowserBinding) =>
  createHash("sha256").update(JSON.stringify(b)).digest("hex");
