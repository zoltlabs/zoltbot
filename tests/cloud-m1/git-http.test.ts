import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { startFixtureGit } from "./git-http.js";
import { harnessRepository } from "./repository.js";

it("clones and pushes to the one owned HTTP remote and refuses other repositories", async () => {
  const root = await mkdtemp("/private/tmp/zoltbot-m1-http-git-");
  let server: Awaited<ReturnType<typeof startFixtureGit>> | undefined;
  try {
    const repository = await harnessRepository(root);
    repository.git(root, ["--git-dir", repository.remote, "config", "http.receivepack", "true"]);
    server = await startFixtureGit(repository.remote);
    const checkout = path.join(root, "checkout");
    const git = (args: string[]) =>
      promisify(execFile)("git", args, {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        timeout: 10000,
      });
    await git(["clone", `${server.origin}/fixture.git`, checkout]);
    await writeFile(path.join(checkout, "README.md"), "Reviewed synthetic change\n");
    repository.git(checkout, ["add", "README.md"]);
    repository.git(checkout, [
      "-c",
      "user.name=Zolt Labs",
      "-c",
      "user.email=zolt@zoltbot.ai",
      "commit",
      "-m",
      "Review fixture",
    ]);
    await git(["-C", checkout, "push", "origin", "HEAD:refs/heads/reviewed"]);
    expect(
      repository.git(root, ["--git-dir", repository.remote, "rev-parse", "reviewed"]).toString(),
    ).toBe(repository.git(checkout, ["rev-parse", "HEAD"]).toString());
    for (const suffix of [
      "/other.git/info/refs?service=git-upload-pack",
      "/fixture.git/../config",
      "/fixture.git/info/refs?service=other",
      "/fixture.git/HEAD",
    ]) {
      expect((await fetch(`${server.origin}${suffix}`)).status).toBe(404);
    }
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
