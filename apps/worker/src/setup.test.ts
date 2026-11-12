import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareWorkerRepository, type WorkerSetupOptions } from "./setup.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(script = "printf ran >> setup-count") {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-worker-setup-")),
    cwd = path.join(root, "repo"),
    directory = path.join(root, "control");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(cwd);
  const options: WorkerSetupOptions = {
    directory,
    cwd,
    orgId: "org",
    taskId: "task",
    baseCommit: "a".repeat(40),
    script,
    environment: { PATH: "/usr/bin:/bin", HOME: root },
    guard() {},
  };
  return { root, cwd, directory, options, signal: new AbortController().signal };
}
it("runs setup once, resumes its ready checkpoint and keeps environment values out of its metadata", async () => {
  const f = await fixture('printf ran >> setup-count; printf "%s" "$GITHUB_TOKEN"'),
    value = randomBytes(32).toString("base64url");
  f.options.environment.GITHUB_TOKEN = value;
  await prepareWorkerRepository(f.options, f.signal);
  await prepareWorkerRepository(f.options, f.signal);
  expect(await readFile(path.join(f.cwd, "setup-count"), "utf8")).toBe("ran");
  const bytes = await readFile(path.join(f.directory, "setup.json"), "utf8");
  expect(JSON.parse(bytes).state).toBe("ready");
  expect(bytes).not.toContain(value);
  expect(bytes).not.toContain(f.options.script);
  expect((await stat(path.join(f.directory, "setup.json"))).mode & 0o777).toBe(0o600);
  await expect(readFile(path.join(f.cwd, "setup.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses task, base and setup changes after initialization and a corrupted checkpoint", async () => {
  const f = await fixture();
  await prepareWorkerRepository(f.options, f.signal);
  for (const changed of [
    { taskId: "other" },
    { baseCommit: "b".repeat(40) },
    { script: "printf changed" },
  ])
    await expect(prepareWorkerRepository({ ...f.options, ...changed }, f.signal)).rejects.toThrow(
      "worker_setup_scope_conflict",
    );
  await writeFile(path.join(f.directory, "setup.json"), "null");
  await expect(prepareWorkerRepository(f.options, f.signal)).rejects.toThrow(
    "worker_setup_unavailable",
  );
  expect(await readFile(path.join(f.cwd, "setup-count"), "utf8")).toBe("ran");
});
it("retains failure without rerunning a partially completed script", async () => {
  const f = await fixture("printf ran >> setup-count; exit 7");
  for (let retry = 0; retry < 2; retry++)
    await expect(prepareWorkerRepository(f.options, f.signal)).rejects.toThrow(
      "worker_setup_failed",
    );
  expect(await readFile(path.join(f.cwd, "setup-count"), "utf8")).toBe("ran");
});
it("bounds setup time and output and refuses canceled starts", async () => {
  const f = await fixture("sleep 30");
  await expect(prepareWorkerRepository({ ...f.options, timeoutMs: 30 }, f.signal)).rejects.toThrow(
    "worker_setup_timeout",
  );
  const g = await fixture("yes synthetic-output");
  await expect(prepareWorkerRepository(g.options, g.signal)).rejects.toThrow(
    "worker_setup_output_limit",
  );
  const h = await fixture(),
    controller = new AbortController();
  controller.abort();
  await expect(prepareWorkerRepository(h.options, controller.signal)).rejects.toThrow(
    "worker_setup_canceled",
  );
  await expect(readFile(path.join(h.cwd, "setup-count"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses a symlink control directory without changing its target", async () => {
  const f = await fixture(),
    other = path.join(f.root, "other");
  await mkdir(other);
  await writeFile(path.join(other, "keep"), "unchanged");
  await symlink(other, f.directory);
  await expect(prepareWorkerRepository(f.options, f.signal)).rejects.toThrow(
    "worker_setup_unavailable",
  );
  expect(await readFile(path.join(other, "keep"), "utf8")).toBe("unchanged");
});
it("kills the setup group after a parent crash and refuses to repeat its uncertain effects", async () => {
  const f = await fixture("printf ran >> setup-count; printf '%s' $$ > setup.pid; sleep 30"),
    launcher = path.join(f.root, "launcher.mjs");
  await writeFile(
    launcher,
    `import { prepareWorkerRepository } from ${JSON.stringify(new URL("./setup.ts", import.meta.url).href)};\nawait prepareWorkerRepository({...${JSON.stringify(f.options)},guard(){}},new AbortController().signal);\n`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", launcher], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      stdio: "ignore",
    }),
    exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let pid: number | undefined;
  const running = (value: number) => {
    try {
      process.kill(value, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await expect
      .poll(
        async () => {
          pid =
            Number(await readFile(path.join(f.cwd, "setup.pid"), "utf8").catch(() => "")) ||
            undefined;
          return pid !== undefined;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    child.kill("SIGKILL");
    await exit;
    const ownedPid = pid;
    if (!ownedPid) throw new Error("fixture_setup_pid_missing");
    await expect.poll(() => running(ownedPid), { timeout: 10000 }).toBe(false);
    await expect(prepareWorkerRepository(f.options, f.signal)).rejects.toThrow(
      "worker_setup_interrupted",
    );
    expect(await readFile(path.join(f.cwd, "setup-count"), "utf8")).toBe("ran");
  } finally {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    if (pid && running(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    await exit;
  }
});
