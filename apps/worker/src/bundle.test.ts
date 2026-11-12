import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("starts the built worker far enough to reject missing configuration with a fixed error", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zoltbot-worker-bundle-"));
  const directory = fileURLToPath(new URL("../", import.meta.url));
  try {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
    const build = spawnSync(process.execPath, [path.join(directory, "build.mjs")], {
      env,
      encoding: "utf8",
      timeout: 30000,
    });
    expect(build.status, build.stderr).toBe(0);
    const boot = spawnSync(process.execPath, [path.join(directory, "dist/main.mjs")], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(boot.status).toBe(1);
    expect(boot.stdout).toBe("");
    expect(boot.stderr.trim()).toBe("worker_start_unavailable");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
