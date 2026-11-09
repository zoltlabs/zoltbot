import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { readyChild } from "./ready-child.js";

it("waits for fixture readiness separately from provider protocol deadlines", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('ZOLTBOT_FAKE_READY\\n');setInterval(()=>{},1000)"],
    { env: {}, stdio: "pipe" },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await readyChild(child);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});
it("terminates a fixture that never becomes ready", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    env: {},
    stdio: "pipe",
  });
  await expect(readyChild(child, 50)).rejects.toThrow("fake_startup_timeout");
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});
