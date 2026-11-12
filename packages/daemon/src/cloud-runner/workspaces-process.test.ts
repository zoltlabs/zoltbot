import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const mode of ["abort", "parent_crash"] as const) {
  it(`reaps a managed Git process after ${mode} without touching other processes`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-managed-process-"));
    const binaries = path.join(root, "bin"),
      pidFile = path.join(root, "git.pid");
    await mkdir(binaries);
    const binary = path.join(binaries, "git");
    // A headless stand-in blocks even check-ref-format, before any repository mutation.
    await writeFile(
      binary,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000);\n`,
    );
    await chmod(binary, 0o700);
    const moduleUrl = new URL("./workspaces.ts", import.meta.url).href;
    const launcher = path.join(root, "launcher.mjs");
    await writeFile(
      launcher,
      `import { ManagedWorkspaces } from ${JSON.stringify(moduleUrl)};
const controller = new AbortController();
process.on("message", () => controller.abort());
try {
  await new ManagedWorkspaces({ directory: ${JSON.stringify(path.join(root, "managed"))} }).prepare({ orgId:"org",taskId:"task",repository:"example/repository",defaultBranch:"main" },controller.signal);
  process.exitCode=2;
} catch(error) { process.exitCode=error.message==="managed_workspace_canceled"?0:3; }
process.disconnect();
`,
    );
    const child = spawn(process.execPath, ["--import", "tsx", launcher], {
      cwd: process.cwd(),
      env: { PATH: `${binaries}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}` },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
    let gitPid: number | undefined;
    try {
      await expect
        .poll(
          async () => {
            const text = await readFile(pidFile, "utf8").catch(() => "");
            gitPid = Number(text) || undefined;
            return gitPid !== undefined;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      const pid = gitPid;
      if (!pid) throw new Error("fixture_process_missing");
      expect(running(pid)).toBe(true);
      if (mode === "abort") child.send("abort");
      else child.kill("SIGKILL");
      expect(await exit).toBe(mode === "abort" ? 0 : null);
      await expect.poll(() => running(pid), { timeout: 10000 }).toBe(false);
      expect(running(process.pid)).toBe(true);
    } finally {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      if (gitPid && running(gitPid)) {
        try {
          process.kill(gitPid, "SIGKILL");
        } catch {}
      }
      await exit;
      await rm(root, { recursive: true, force: true });
    }
  });
}
