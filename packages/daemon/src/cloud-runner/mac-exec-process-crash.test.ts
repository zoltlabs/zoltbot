import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("reaps only the owned Mac command group when its Node parent dies", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mac-command-crash-"));
  const environment = {
    HOME: root,
    ZDOTDIR: root,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
  };
  const script = path.join(root, "parent.mjs");
  writeFileSync(
    script,
    `
import { macCommandProcess } from ${JSON.stringify(new URL("./mac-exec-process.ts", import.meta.url).href)};
const execute = macCommandProcess({directory: ${JSON.stringify(path.join(root, "output"))},
  mac: "Test Mac", shell: ${JSON.stringify(process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")},
  environment: ${JSON.stringify(environment)}, chunk(frame) { if (frame.stream === "stdout") process.stdout.write(frame.data); }});
await execute({requestId: "request", taskId: "task", command: "echo $$; exec sleep 30",
  cwd: ${JSON.stringify(root)}, stdin: "", timeoutSeconds: 30}, new AbortController().signal);
`,
    { mode: 0o600 },
  );
  const parent = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), script], {
    env: environment,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const sentinel = spawn("/bin/sleep", ["30"], { env: environment, stdio: "ignore" });
  sentinel.on("error", () => {});
  const sentinelExited = new Promise<void>((resolve) => sentinel.once("close", () => resolve()));
  let group: number | undefined;
  const exited = new Promise<void>((resolve) => parent.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture_parent_not_ready")), 5000);
      let output = "";
      parent.once("error", () => {
        clearTimeout(timer);
        reject(new Error("fixture_parent_failed"));
      });
      parent.stdout.on("data", (data: Buffer) => {
        output += data.toString("utf8");
        if (!/^\d+\n$/.test(output)) return;
        const pid = Number(output.trim());
        if (!Number.isSafeInteger(pid) || pid <= 1) return;
        group = pid;
        clearTimeout(timer);
        resolve();
      });
    });
    parent.kill("SIGKILL");
    await exited;
    await expect
      .poll(
        () => {
          try {
            process.kill(group as number, 0);
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 8000 },
      )
      .toBe(true);
    if (!sentinel.pid) throw new Error("fixture_sentinel_missing");
    expect(() => process.kill(sentinel.pid as number, 0)).not.toThrow();
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGKILL");
      await exited;
    }
    if (group) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {}
    }
    if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill("SIGKILL");
    await sentinelExited;
    rmSync(root, { recursive: true, force: true });
  }
});
