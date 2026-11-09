import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { acquireOwnerLock } from "./owner-lock.js";

it("holds an exclusive owner lease until release without unlinking its inode", () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/owner-lock-")),
    file = path.join(root, "owner.sqlite");
  const first = acquireOwnerLock(file);
  try {
    expect(() => acquireOwnerLock(file)).toThrow("daemon_already_running");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    first.release();
    first.release();
    const second = acquireOwnerLock(file);
    second.release();
    expect(existsSync(file)).toBe(true);
  } finally {
    first.release();
    rmSync(root, { recursive: true, force: true });
  }
});
it("retains the owner lease through garbage collection and releases it after the real process is killed", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/owner-kill-")),
    file = path.join(root, "owner.sqlite");
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { acquireOwnerLock } from './packages/store/src/owner-lock.ts'; const lease = acquireOwnerLock(process.argv[1]); process.on('SIGTERM', () => { lease.release(); process.exit(0); }); global.gc(); setTimeout(() => process.stdout.write('LOCKED\\n'), 25); setInterval(() => {}, 1000);`,
      file,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, TMPDIR: root, TSX_DISABLE_CACHE: "1" },
      stdio: "pipe",
    },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", data);
        child.off("error", error);
        child.off("exit", exit);
      };
      const fail = (reason: string) => {
        cleanup();
        reject(new Error(reason));
      };
      const data = (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.length > 1024) {
          fail("unexpected_owner_output");
          return;
        }
        if (!buffer.includes("\n")) return;
        if (buffer.trim() !== "LOCKED") {
          fail("unexpected_owner_output");
          return;
        }
        cleanup();
        resolve();
      };
      const error = () => fail("owner_child_failed");
      const exit = () => fail("owner_child_exited");
      const timer = setTimeout(() => fail("owner_child_not_ready"), 5000);
      child.stdout.on("data", data);
      child.once("error", error);
      child.once("exit", exit);
    });
    expect(() => acquireOwnerLock(file)).toThrow("daemon_already_running");
    child.kill("SIGKILL");
    await closed;
    const replacement = acquireOwnerLock(file);
    replacement.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a symlink at the sidecar path", () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/owner-link-"));
  const file = path.join(root, "owner.sqlite"),
    link = path.join(root, "link.sqlite");
  const owner = acquireOwnerLock(file);
  owner.release();
  try {
    symlinkSync(file, link);
    expect(() => acquireOwnerLock(link)).toThrow("owner_lock_symlink");
    const replacement = acquireOwnerLock(file);
    replacement.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
