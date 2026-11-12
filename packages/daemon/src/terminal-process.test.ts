import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { terminalProcessGroups } from "./terminal-process.js";

it("terminates a detached shell's foreground and background process groups", async () => {
  const child = spawn("/bin/sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
  await once(child, "spawn");
  if (!child.pid) throw Error("fixture_spawn_failed");
  try {
    const exit = once(child, "exit");
    const signal = terminalProcessGroups(child.pid);
    expect(signal("SIGTERM")).toBe(true);
    await exit;
    signal("SIGKILL");
    expect(() => process.kill(-Number(child.pid), 0)).toThrow();
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
});
