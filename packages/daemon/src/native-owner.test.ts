import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { inspectNativeOwner } from "./native-owner.js";

it("returns only external holder pids and uses no process argument listing", async () => {
  const result = await inspectNativeOwner("/fixture/session.jsonl", {
    platform: "darwin",
    ownedPids: [42],
    runner: async (command, args, options) => {
      expect(command).toBe("/usr/sbin/lsof");
      expect(args).toEqual(["-t", "-n", "-P", "--", "/fixture/session.jsonl"]);
      expect(options.timeoutMs).toBe(2000);
      expect(options.inherited).toEqual({});
      return { code: 0, stdout: "42\n99\n99\n", stderr: "" };
    },
  });
  expect(result).toEqual({ state: "busy", pids: [99], recommendation: "fork" });
});
it("detects a real fake process holding a synthetic native session file", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/native-holder-"));
  const file = path.join(root, "session.jsonl");
  writeFileSync(file, "synthetic session");
  const child = spawn(
    process.execPath,
    [
      "-e",
      "require('node:fs').openSync(process.argv[1], 'r+');console.log('ready');setInterval(()=>{},1000)",
      file,
    ],
    {
      cwd: root,
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
      child.once("exit", () => reject(new Error("holder_exited")));
    });
    const owner = await inspectNativeOwner(file);
    if (process.platform === "darwin") {
      expect(owner).toEqual({ state: "busy", pids: [child.pid], recommendation: "fork" });
    } else {
      expect(owner.state).toBe("unknown");
    }
    child.kill("SIGTERM");
    await closed;
    if (process.platform === "darwin")
      expect(await inspectNativeOwner(file)).toEqual({ state: "clear", pids: [] });
  } finally {
    child.kill("SIGTERM");
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});
it("distinguishes an empty successful query from unavailable or malformed inspection", async () => {
  const inspect = (code: number, stdout: string) =>
    inspectNativeOwner("/fixture/session.jsonl", {
      platform: "darwin",
      runner: async () => ({ code, stdout, stderr: "" }),
    });
  expect(await inspect(1, "")).toEqual({ state: "clear", pids: [] });
  expect(await inspect(0, "private unexpected output")).toEqual({
    state: "unknown",
    pids: [],
    recommendation: "fork",
  });
  expect(await inspect(2, "")).toEqual({ state: "unknown", pids: [], recommendation: "fork" });
  expect(await inspectNativeOwner("relative", { platform: "darwin" })).toEqual({
    state: "unknown",
    pids: [],
    recommendation: "fork",
  });
});
