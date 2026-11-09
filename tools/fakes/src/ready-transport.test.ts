import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { Logger, Redactor, Supervisor } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { readyTransport } from "./ready-transport.js";

it("waits for fixture readiness before exposing the protocol transport", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/ready-fixture-"));
  const supervisor = new Supervisor(
    {
      command: process.execPath,
      args: [
        "-e",
        "setTimeout(()=>{console.error('ZOLTBOT_FAKE_READY');console.log('available')},30);setInterval(()=>{},1000)",
      ],
      cwd: root,
      env: { HOME: root, TMPDIR: root },
      frameFile: path.join(root, "frames.jsonl"),
      killGraceMs: 10,
    },
    new Logger(path.join(root, "process.log"), new Redactor()),
  );
  try {
    const transport = await readyTransport(supervisor);
    expect(supervisor.stderrTail).toContain("ZOLTBOT_FAKE_READY");
    const reader = transport.input.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("available");
    reader.releaseLock();
    await transport.close();
    expect(supervisor.status).toBe("closed");
  } finally {
    await supervisor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("bounds and cleans up a fixture that never becomes ready", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/unready-fixture-"));
  const supervisor = new Supervisor(
    {
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: root,
      env: { HOME: root, TMPDIR: root },
      frameFile: path.join(root, "frames.jsonl"),
      killGraceMs: 10,
    },
    new Logger(path.join(root, "process.log"), new Redactor()),
  );
  try {
    await expect(readyTransport(supervisor, 30)).rejects.toThrow("fake_startup_timeout");
    expect(supervisor.status).toBe("closed");
  } finally {
    await supervisor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
