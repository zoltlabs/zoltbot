import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { harnessRepository } from "./repository.js";

it("supports the managed checkout's Git commands while keeping all remote operations on the bare fixture", async () => {
  const root = await mkdtemp("/private/tmp/zoltbot-m1-git-");
  try {
    const fixture = await harnessRepository(root),
      destination = path.join(root, "checkout");
    const env = {
      PATH: [fixture.bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (cwd: string, args: string[]) =>
      spawnSync(path.join(fixture.bin, "git"), args, { cwd, env, stdio: "ignore" }).status;
    expect(git(root, ["check-ref-format", "--branch", "main"])).toBe(0);
    expect(
      git(root, ["clone", "--", "https://github.com/example/repository.git", destination]),
    ).toBe(0);
    expect(git(destination, ["switch", "-c", "zoltbot/task-test"])).toBe(0);
    expect(
      fixture.git(destination, ["config", "--get", "remote.origin.url"]).toString().trim(),
    ).toBe("https://github.com/example/repository.git");
    expect(git(root, ["ls-remote", "https://other.example.invalid/repository.git"])).toBe(127);
    expect(git(root, ["pull"])).toBe(127);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
