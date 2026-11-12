import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Template } from "e2b";
import { expect, it } from "vitest";

it("converts the base worker Dockerfile through the pinned E2B SDK without an account or build", async () => {
  const dockerfile = await readFile(
    new URL("../../../templates/sandbox/Dockerfile", import.meta.url),
    "utf8",
  );
  const template = Template({ fileContextPath: process.cwd() }).fromDockerfile(dockerfile);
  const definition = await Template.toJSON(template, false);
  expect(definition).toContain("ubuntu:24.04");
  expect(definition).toContain("/usr/local/bin/zolt-worker");
  expect(definition).toContain("pnpm build:worker");
  for (const [provider, name] of [
    ["claude", "@anthropic-ai/claude-code"],
    ["codex", "@openai/codex"],
  ] as const) {
    const pinned = JSON.parse(
      await readFile(
        new URL(`../../adapters/${provider}/definitions/${provider}.json`, import.meta.url),
        "utf8",
      ),
    ) as { testedVersions: string };
    expect(dockerfile).toContain(`${name}@${pinned.testedVersions}`);
  }
});
it("keeps warm-up idle and can launch from an environment-only refresh capability", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-template-entry-"));
  const script = path.resolve("templates/sandbox/start.sh");
  try {
    const node = path.join(root, "node");
    await writeFile(node, "#!/bin/sh\nprintf worker-started\n", { mode: 0o700 });
    await chmod(node, 0o700);
    // The production image uses GNU sleep; the macOS fixture supplies only its idle behavior.
    await writeFile(path.join(root, "sleep"), "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o700 });
    const env = { PATH: `${root}:/usr/bin:/bin` };
    const warm = spawn("/bin/sh", [script], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    warm.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        warm.once("error", reject);
        warm.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const timer = setTimeout(() => warm.kill("SIGTERM"), 100);
    try {
      expect(await ended).toEqual({ code: null, signal: "SIGTERM" });
      expect(output).toBe("");
    } finally {
      clearTimeout(timer);
      warm.kill("SIGKILL");
    }
    const task = await promisify(execFile)("/bin/sh", [script], {
      env: { ...env, ZOLTBOT_WORKER_REFRESH: randomBytes(32).toString("base64url") },
    });
    expect(task.stdout).toBe("worker-started");
    expect(task.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
