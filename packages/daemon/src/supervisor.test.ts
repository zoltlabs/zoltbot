import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { Logger, Redactor } from "./logging.js";
import { Supervisor } from "./supervisor.js";

const roots: string[] = [];
const children: Supervisor[] = [];
function child(
  script: string,
  extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {},
  redactor = new Redactor(["seeded-secret"]),
) {
  mkdirSync(".cache/tests", { recursive: true });
  const dir = mkdtempSync(path.resolve(".cache/tests/process-"));
  roots.push(dir);
  const logger = new Logger(path.join(dir, "log.jsonl"), redactor);
  const process = new Supervisor(
    {
      command: globalThis.process.execPath,
      args: ["-e", script],
      cwd: dir,
      backoffMs: 5,
      killGraceMs: 20,
      frameFile: path.join(dir, "frames.jsonl"),
      ...extra,
    },
    logger,
  );
  children.push(process);
  return process;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await delay(10);
  expect(check()).toBe(true);
}
afterEach(async () => {
  for (const c of children.splice(0)) await c.close();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("drains UTF8 frames and gives children only the allowed environment", async () => {
  const p = child(
    'process.stdout.write(JSON.stringify({text:"hello 🌎",leak:process.env.ZOLTBOT_UNLISTED_SECRET})+"\\n");setInterval(()=>{},1000);',
  );
  globalThis.process.env.ZOLTBOT_UNLISTED_SECRET = "must-not-leak";
  const frames: string[] = [];
  p.on("stdout", (line) => frames.push(line));
  p.start();
  await until(() => frames.length === 1);
  expect(JSON.parse(frames[0] ?? "{}")).toEqual({ text: "hello 🌎" });
  delete globalThis.process.env.ZOLTBOT_UNLISTED_SECRET;
});
it("stops after three start failures and rejects every pending request", async () => {
  const p = child("process.exit(1)");
  p.start();
  const pending = p.track(new Promise(() => {}));
  await expect(pending).rejects.toThrow(/process_died/);
  await until(() => p.status === "needs_attention");
  expect(p.starts).toBe(3);
});
it("probes a hung request and restarts when the probe also hangs", async () => {
  const p = child("setInterval(()=>{},1000)");
  p.start();
  await expect(p.guard(new Promise(() => {}), 10, () => new Promise(() => {}))).rejects.toThrow(
    /request_timeout/,
  );
  await until(() => p.starts >= 2);
});
it("redacts and caps frame logs and stderr", async () => {
  const p = child(
    'process.stderr.write("seeded-secret\\n");for(let i=0;i<50;i++)process.stdout.write("seeded-secret"+"x".repeat(80)+"\\n");setInterval(()=>{},1000);',
    { frameLimitBytes: 512 },
  );
  p.start();
  await until(() => p.stderrTail.length > 0);
  const text = readFileSync(p.frameFile, "utf8");
  expect(text).not.toContain("seeded-secret");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
  expect(p.stderrTail.join("")).not.toContain("seeded-secret");
});

it("makes concurrent close callers wait for the same physical shutdown", async () => {
  const p = child('process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);');
  let ready = false;
  p.on("stdout", () => {
    ready = true;
  });
  p.start();
  await until(() => ready);
  const first = p.close();
  const second = p.close();
  try {
    await second;
    expect(p.status).toBe("closed");
  } finally {
    await first;
  }
});

it("withholds private frame payloads while keeping native stdout unchanged", async () => {
  const value = "synthetic-private-stream-value";
  const redactor = new Redactor([value]);
  redactor.hideFrames();
  const process = child(
    "let input = ''; process.stdin.on('data', data => { input += data; if (input.includes('\\n')) { const value = JSON.parse(input).value; process.stdout.write(JSON.stringify({ delta: value.slice(0, 10) }) + '\\n'); process.stderr.write(value.slice(10) + '\\n'); process.stdout.write(JSON.stringify({ delta: value.slice(10) }) + '\\n'); input = ''; } });",
    {},
    redactor,
  );
  const output: string[] = [],
    errors: string[] = [];
  process.on("stdout", (line: string) => output.push(JSON.parse(line).delta));
  process.on("stderr", (line: string) => errors.push(line));
  process.start();
  process.write(JSON.stringify({ value }));
  await until(() => output.length === 2 && errors.length === 1);
  expect(output.join("")).toBe(value);
  expect(errors.join("")).not.toContain(value.slice(10));
  const frames = readFileSync(process.frameFile, "utf8");
  expect(frames).not.toContain(value.slice(0, 10));
  expect(frames).not.toContain(value.slice(10));
  for (const line of frames.trim().split("\n"))
    expect(JSON.parse(JSON.parse(line).line)).toMatchObject({
      redacted: true,
      reason: "private_answer",
    });
});

it("turns a closed native stdin pipe into a bounded provider fault instead of crashing the daemon", async () => {
  const p = child(
    "require('node:fs').closeSync(0); process.stdout.write('ready\\n'); setInterval(()=>{},1000)",
  );
  let ready = false;
  const faults: string[] = [];
  p.on("stdout", () => {
    ready = true;
  });
  p.on("fault", (code) => faults.push(code));
  p.start();
  await until(() => ready);
  await expect(p.writeAsync("synthetic input")).rejects.toThrow();
  await until(() => faults.includes("provider_input_closed"));
  await p.close();
  expect(p.status).toBe("closed");
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pids: number[], ms: number) {
  for (let waited = 0; waited < ms && pids.some(alive); waited += 50) await delay(50);
  return pids.filter(alive);
}
// The provider leaves a helper in its process group, like an MCP server a CLI starts.
const withHelper = (file: string) =>
  `const {spawn}=require("node:child_process");const fs=require("node:fs");` +
  `const helper=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});` +
  `fs.writeFileSync(${JSON.stringify(file)},JSON.stringify([process.pid,helper.pid]));`;

it.skipIf(process.platform === "win32")(
  "stops the provider and its helpers when it exits on its own",
  async () => {
    mkdirSync(".cache/tests", { recursive: true });
    const file = path.join(mkdtempSync(path.resolve(".cache/tests/group-")), "pids.json");
    roots.push(path.dirname(file));
    const p = child(`${withHelper(file)}setTimeout(()=>process.exit(0),100);`);
    p.start();
    await until(() => {
      try {
        return JSON.parse(readFileSync(file, "utf8")).length === 2;
      } catch {
        return false;
      }
    });
    const pids: number[] = JSON.parse(readFileSync(file, "utf8"));
    expect(await gone(pids, 3000)).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "stops the provider and its helpers when the daemon is killed",
  async () => {
    mkdirSync(".cache/tests", { recursive: true });
    const dir = mkdtempSync(path.resolve(".cache/tests/crash-"));
    roots.push(dir);
    const file = path.join(dir, "pids.json");
    // A stand-in daemon starts a provider, then dies without any chance to clean up.
    const daemon = path.join(dir, "daemon.mts");
    writeFileSync(
      daemon,
      `import { Logger, Redactor } from ${JSON.stringify(path.resolve("packages/daemon/src/logging.ts"))};
import { Supervisor } from ${JSON.stringify(path.resolve("packages/daemon/src/supervisor.ts"))};
const supervisor = new Supervisor(
  { command: process.execPath, args: ["-e", ${JSON.stringify(`${withHelper(file)}setInterval(()=>{},1000);`)}], cwd: ${JSON.stringify(dir)}, frameFile: ${JSON.stringify(path.join(dir, "frames.jsonl"))} },
  new Logger(${JSON.stringify(path.join(dir, "log.jsonl"))}, new Redactor()),
);
supervisor.start();
const fs = await import("node:fs");
while (!fs.existsSync(${JSON.stringify(file)})) await new Promise((r) => setTimeout(r, 20));
process.kill(process.pid, "SIGKILL");
`,
    );
    const crashed = spawnSync(process.execPath, ["--import", "tsx", daemon], {
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
      timeout: 30000,
    });
    expect(crashed.signal).toBe("SIGKILL");
    const pids: number[] = JSON.parse(readFileSync(file, "utf8"));
    expect(pids).toHaveLength(2);
    // Cleanup may already have finished by the time spawnSync returns.
    // The watcher sends TERM at once and KILL five seconds later.
    expect(await gone(pids, 8000)).toEqual([]);
  },
  20000,
);

it.skipIf(process.platform === "win32")(
  "lets the desktop daemon survive its UI while still permitting explicit cleanup",
  async () => {
    mkdirSync(".cache/tests", { recursive: true });
    const dir = mkdtempSync(path.resolve(".cache/tests/desktop-crash-"));
    roots.push(dir);
    const file = path.join(dir, "pids.json");
    const desktop = path.join(dir, "desktop.mts");
    writeFileSync(
      desktop,
      `
import { Logger, Redactor } from ${JSON.stringify(path.resolve("packages/daemon/src/logging.ts"))};
import { Supervisor } from ${JSON.stringify(path.resolve("packages/daemon/src/supervisor.ts"))};
const supervisor = new Supervisor(
  { command: process.execPath, args: ["-e", ${JSON.stringify(`${withHelper(file)}setInterval(()=>{},1000);`)}], cwd: ${JSON.stringify(dir)}, frameFile: ${JSON.stringify(path.join(dir, "frames.jsonl"))}, surviveParentExit: true },
  new Logger(${JSON.stringify(path.join(dir, "log.jsonl"))}, new Redactor()),
);
supervisor.start();
const fs = await import("node:fs");
while (!fs.existsSync(${JSON.stringify(file)})) await new Promise((r) => setTimeout(r, 20));
process.kill(process.pid, "SIGKILL");
`,
    );
    const crashed = spawnSync(process.execPath, ["--import", "tsx", desktop], {
      env: { ...process.env, TSX_DISABLE_CACHE: "1" },
      timeout: 30000,
    });
    const pids: number[] = JSON.parse(readFileSync(file, "utf8"));
    try {
      expect(crashed.signal).toBe("SIGKILL");
      await delay(200);
      expect(pids.every(alive)).toBe(true);
    } finally {
      process.kill(-(pids[0] as number), "SIGKILL");
      expect(await gone(pids, 3000)).toEqual([]);
    }
  },
);
