import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ManagedWorkspaces } from "./workspaces.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim();
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-cloud-publish-"));
  roots.push(root);
  const source = path.join(root, "source"),
    remote = path.join(root, "remote.git");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "-b", "main", source]);
  const commit = async (cwd: string, content: string) => {
    await writeFile(path.join(cwd, "file.txt"), content);
    git(cwd, ["add", "."]);
    git(cwd, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Synthetic change",
    ]);
    return git(cwd, ["rev-parse", "HEAD"]);
  };
  const base = await commit(source, "Initial\n");
  git(source, ["push", remote, "main"]);
  const value = randomBytes(32).toString("base64url");
  let credentialReads = 0;
  const managed = new ManagedWorkspaces({
    directory: path.join(root, "managed"),
    localRepository: () => remote,
    githubToken: async () => {
      credentialReads++;
      return value;
    },
  });
  const input = {
      orgId: "org",
      taskId: "task",
      repository: "example/repository",
      defaultBranch: "main",
    },
    signal = new AbortController().signal;
  const workspace = await managed.prepare(input, signal);
  credentialReads = 0;
  return {
    root,
    remote,
    source,
    base,
    value,
    managed,
    input,
    workspace,
    signal,
    commit,
    credentialReads: () => credentialReads,
    remoteHead: () => git(remote, ["rev-parse", "refs/heads/zoltbot/task"]),
  };
}
it("publishes only the reviewed commit and reconciles retries without putting credentials in Git configuration", async () => {
  const f = await fixture(),
    head = await f.commit(f.workspace.cwd, "Reviewed change\n");
  const authorize = vi.fn(async () => {}),
    proposal = { branch: "zoltbot/task", head };
  expect(await f.managed.publish(f.input, proposal, f.signal, authorize)).toEqual({
    ...proposal,
    repository: f.input.repository,
    pushed: true,
  });
  expect(f.remoteHead()).toBe(head);
  await f.managed.publish(f.input, proposal, f.signal, authorize);
  expect(f.remoteHead()).toBe(head);
  expect(authorize).toHaveBeenCalled();
  expect(
    (await readFile(path.join(f.workspace.cwd, ".git/config"), "utf8")).includes(f.value),
  ).toBe(false);
});
it("refuses changed or dirty work, unsafe local configuration and failed authorization before requesting credentials", async () => {
  const f = await fixture(),
    proposal = { head: f.base, branch: "zoltbot/task" };
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "Uncommitted\n");
  await expect(f.managed.publish(f.input, proposal, f.signal, async () => {})).rejects.toThrow(
    "managed_publication_unavailable",
  );
  await f.commit(f.workspace.cwd, "Unreviewed commit\n");
  await expect(f.managed.publish(f.input, proposal, f.signal, async () => {})).rejects.toThrow(
    "managed_publication_unavailable",
  );
  expect(f.credentialReads()).toBe(0);
  const head = git(f.workspace.cwd, ["rev-parse", "HEAD"]);
  git(f.workspace.cwd, ["config", "http.proxy", "http://example.invalid"]);
  await expect(
    f.managed.publish(f.input, { ...proposal, head }, f.signal, async () => {}),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.credentialReads()).toBe(0);
  git(f.workspace.cwd, ["config", "--unset", "http.proxy"]);
  await expect(
    f.managed.publish(f.input, { ...proposal, head }, f.signal, async () => {
      throw new Error("private_context_changed");
    }),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.credentialReads()).toBe(0);
});
it("pins prior publications, rejects branch collisions and never replaces non-ancestor remote history", async () => {
  const f = await fixture(),
    head = await f.commit(f.workspace.cwd, "First review\n");
  await f.managed.publish(f.input, { head, branch: "zoltbot/task" }, f.signal, async () => {});
  const next = await f.commit(f.workspace.cwd, "Next review\n");
  await expect(
    f.managed.publish(f.input, { head: next, branch: "zoltbot/task" }, f.signal, async () => {}),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.remoteHead()).toBe(head);
  await f.managed.publish(
    f.input,
    { head: next, previousHead: head, branch: "zoltbot/task" },
    f.signal,
    async () => {},
  );
  expect(f.remoteHead()).toBe(next);
  git(f.workspace.cwd, ["checkout", "--detach", f.base]);
  const unrelated = await f.commit(f.workspace.cwd, "Independent review\n");
  await expect(
    f.managed.publish(
      f.input,
      { head: unrelated, previousHead: next, branch: "zoltbot/task" },
      f.signal,
      async () => {},
    ),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.remoteHead()).toBe(next);
});
it.each([
  "main",
  "master",
  "HEAD",
  "--invalid",
])("refuses protected or invalid branch %s", async (branch) => {
  const f = await fixture();
  await expect(
    f.managed.publish(f.input, { head: f.base, branch }, f.signal, async () => {}),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.credentialReads()).toBe(0);
});
it("reconciles a lost push reply through the exact remote commit without a second push", async () => {
  const f = await fixture(),
    head = await f.commit(f.workspace.cwd, "Reviewed change\n"),
    realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const binary = path.join(f.root, "git"),
    counter = path.join(f.root, "push-count");
  await writeFile(
    binary,
    `#!/usr/bin/env node\nconst fs=require("node:fs"),cp=require("node:child_process"),args=process.argv.slice(2);const result=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"});if(args.includes("push")&&result.status===0){fs.appendFileSync(${JSON.stringify(counter)},"p");process.exit(1);}process.exit(result.status??1);\n`,
  );
  await chmod(binary, 0o700);
  vi.stubEnv("PATH", `${f.root}${path.delimiter}${process.env.PATH}`);
  const proposal = { head, branch: "zoltbot/task" };
  expect((await f.managed.publish(f.input, proposal, f.signal, async () => {})).pushed).toBe(true);
  expect(await readFile(counter, "utf8")).toBe("p");
  expect((await f.managed.publish(f.input, proposal, f.signal, async () => {})).pushed).toBe(true);
  expect(await readFile(counter, "utf8")).toBe("p");
});

it("checks intermediate history before requesting credentials, including content removed from the final diff", async () => {
  const f = await fixture();
  await f.commit(f.workspace.cwd, "Historical content\n");
  const head = await f.commit(f.workspace.cwd, "Final reviewed content\n");
  await expect(
    f.managed.publish(f.input, { head, branch: "zoltbot/task" }, f.signal, async (content) => {
      if (content?.includes("Historical content\n")) throw new Error("private_context");
    }),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.credentialReads()).toBe(0);
  expect(git(f.remote, ["ls-remote", "--heads", f.remote, "refs/heads/zoltbot/task"])).toBe("");
});

it("refuses oversized intermediate content without requesting credentials or pushing a branch", async () => {
  const f = await fixture();
  await f.commit(f.workspace.cwd, "x".repeat(1048577));
  const head = await f.commit(f.workspace.cwd, "Small final change\n");
  await expect(
    f.managed.publish(f.input, { head, branch: "zoltbot/task" }, f.signal, async () => {}),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.credentialReads()).toBe(0);
  expect(git(f.remote, ["ls-remote", "--heads", f.remote, "refs/heads/zoltbot/task"])).toBe("");
});

it("refuses a remote whose name shadows the literal destination before reading credentials", async () => {
  const f = await fixture();
  git(f.workspace.cwd, ["config", `remote.${f.remote}.url`, f.source]);
  await expect(
    f.managed.publish(f.input, { head: f.base, branch: "zoltbot/task" }, f.signal, async () => {}),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.credentialReads()).toBe(0);
});

it("refuses shallow metadata that could hide intermediate history", async () => {
  const f = await fixture(),
    head = await f.commit(f.workspace.cwd, "Reviewed change\n");
  await writeFile(path.join(f.workspace.cwd, ".git", "shallow"), `${head}\n`);
  await expect(
    f.managed.publish(f.input, { head, branch: "zoltbot/task" }, f.signal, async () => {}),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.credentialReads()).toBe(0);
});

it("refuses worktree configuration that could override a pinned transport", async () => {
  const f = await fixture();
  git(f.workspace.cwd, ["config", "extensions.worktreeConfig", "true"]);
  await writeFile(
    path.join(f.workspace.cwd, ".git/config.worktree"),
    "[http]\n\tproxy = http://example.invalid\n",
  );
  await expect(
    f.managed.publish(f.input, { head: f.base, branch: "zoltbot/task" }, f.signal, async () => {}),
  ).rejects.toThrow("managed_publication_unavailable");
  expect(f.credentialReads()).toBe(0);
});
