import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ManagedWorkspaces } from "./workspaces.js";

const roots: string[] = [];
afterEach(async () => {
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
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-managed-workspace-"));
  roots.push(root);
  const source = path.join(root, "source"),
    remote = path.join(root, "remote.git");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "-b", "main", source]);
  await writeFile(path.join(source, "test.txt"), "Initial\n");
  const commit = (message: string) => {
    git(source, ["add", "."]);
    git(source, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      message,
    ]);
    git(source, ["push", remote, "main"]);
    return git(source, ["rev-parse", "HEAD"]);
  };
  const head = commit("Seed");
  const options = { directory: path.join(root, "managed"), localRepository: () => remote };
  const input = {
    orgId: "org",
    taskId: "task",
    repository: "example/repository",
    defaultBranch: "main",
  };
  const signal = new AbortController().signal;
  return { root, source, remote, head, commit, options, input, signal };
}

it("preserves edits and the original base across restart and keeps credentials out of Git config", async () => {
  const f = await fixture();
  const privateValue = randomBytes(32).toString("base64url");
  const options = { ...f.options, githubToken: async () => privateValue };
  const first = await new ManagedWorkspaces(options).prepare(f.input, f.signal);
  expect(first.baseCommit).toBe(f.head);
  await writeFile(path.join(first.cwd, "test.txt"), "Preserved\n");
  await writeFile(path.join(first.cwd, "untracked.txt"), "Keep this too\n");
  await writeFile(path.join(f.source, "test.txt"), "New upstream version\n");
  f.commit("Advance upstream");
  expect(await new ManagedWorkspaces(options).prepare(f.input, f.signal)).toEqual(first);
  expect(await readFile(path.join(first.cwd, "test.txt"), "utf8")).toBe("Preserved\n");
  expect(await readFile(path.join(first.cwd, "untracked.txt"), "utf8")).toBe("Keep this too\n");
  const config = await readFile(path.join(first.cwd, ".git/config"), "utf8");
  const control = path.dirname(first.cwd);
  const binding = await readFile(path.join(control, "binding.json"), "utf8");
  expect(config + binding).not.toContain(privateValue);
  expect(config).not.toContain("extraheader");
  expect(JSON.parse(binding)).toMatchObject({ stage: "ready", baseCommit: f.head });
  expect((await stat(control)).mode & 0o777).toBe(0o700);
  expect((await stat(path.join(control, "binding.json"))).mode & 0o777).toBe(0o600);
});

it("fails closed on a missing used checkout but recovers an interrupted initial clone at its frozen base", async () => {
  const f = await fixture();
  const first = await new ManagedWorkspaces(f.options).prepare(f.input, f.signal);
  const control = path.dirname(first.cwd),
    file = path.join(control, "binding.json");
  await rename(first.cwd, path.join(control, "removed-repo"));
  await expect(new ManagedWorkspaces(f.options).prepare(f.input, f.signal)).rejects.toThrow(
    "managed_workspace_missing",
  );
  const binding = JSON.parse(await readFile(file, "utf8"));
  binding.stage = "prepared";
  await writeFile(file, JSON.stringify(binding));
  await writeFile(path.join(f.source, "test.txt"), "New upstream version\n");
  f.commit("Advance upstream");
  const recovered = await new ManagedWorkspaces(f.options).prepare(f.input, f.signal);
  expect(recovered).toEqual(first);
  expect(git(recovered.cwd, ["rev-parse", "HEAD"])).toBe(f.head);
  expect(await readFile(path.join(recovered.cwd, "test.txt"), "utf8")).toBe("Initial\n");
  expect(JSON.parse(await readFile(file, "utf8")).stage).toBe("ready");
});

it("coalesces duplicate prepares, isolates task and org clones, and refuses scope changes", async () => {
  const f = await fixture(),
    manager = new ManagedWorkspaces(f.options);
  const first = manager.prepare(f.input, f.signal);
  expect(manager.prepare(f.input, f.signal)).toBeInstanceOf(Promise);
  const changed = manager.prepare({ ...f.input, repository: "other/repository" }, f.signal);
  await expect(changed).rejects.toThrow("managed_workspace_scope_conflict");
  const result = await first;
  const otherTask = await manager.prepare({ ...f.input, taskId: "other" }, f.signal);
  const otherOrg = await manager.prepare({ ...f.input, orgId: "other" }, f.signal);
  expect(new Set([result.cwd, otherTask.cwd, otherOrg.cwd]).size).toBe(3);
  await expect(manager.prepare({ ...f.input, defaultBranch: "other" }, f.signal)).rejects.toThrow(
    "managed_workspace_scope_conflict",
  );
});

it("refuses a replaced checkout, Git directory, binding or remote instead of reading a Local project", async () => {
  const f = await fixture();
  const manager = new ManagedWorkspaces(f.options),
    first = await manager.prepare(f.input, f.signal);
  const saved = `${first.cwd}-saved`;
  await rename(first.cwd, saved);
  await symlink(f.source, first.cwd);
  await expect(manager.prepare(f.input, f.signal)).rejects.toThrow("managed_workspace_unavailable");
  await rm(first.cwd);
  await rename(saved, first.cwd);
  git(first.cwd, ["config", "remote.origin.url", "https://example.invalid/other.git"]);
  await expect(manager.prepare(f.input, f.signal)).rejects.toThrow("managed_workspace_changed");
  git(first.cwd, ["config", "remote.origin.url", f.remote]);
  const dotgit = path.join(first.cwd, ".git");
  await rename(dotgit, `${dotgit}-saved`);
  await symlink(`${dotgit}-saved`, dotgit);
  await expect(manager.prepare(f.input, f.signal)).rejects.toThrow("managed_workspace_changed");
  await rm(dotgit);
  await rename(`${dotgit}-saved`, dotgit);
  const binding = path.join(path.dirname(first.cwd), "binding.json");
  await rename(binding, `${binding}-saved`);
  await symlink(`${binding}-saved`, binding);
  await expect(manager.prepare(f.input, f.signal)).rejects.toThrow("managed_workspace_unavailable");
});

it("rejects option injection and canceled starts without asking for credentials", async () => {
  const f = await fixture();
  let calls = 0;
  const manager = new ManagedWorkspaces({
    ...f.options,
    githubToken: async () => {
      calls++;
      return undefined;
    },
  });
  for (const repository of [
    "../repo",
    "owner/..",
    "-owner/repo",
    "owner/repo\n",
    "https://example.invalid/repo",
  ]) {
    await expect(manager.prepare({ ...f.input, repository }, f.signal)).rejects.toThrow(
      "managed_repository_invalid",
    );
  }
  const controller = new AbortController();
  controller.abort();
  await expect(manager.prepare(f.input, controller.signal)).rejects.toThrow(
    "managed_workspace_canceled",
  );
  expect(calls).toBe(0);
});

it("cancels a blocked credential lookup and passes its lifetime signal to the keychain host", async () => {
  const f = await fixture(),
    controller = new AbortController();
  let requested = false;
  const manager = new ManagedWorkspaces({
    ...f.options,
    githubToken: async (signal) => {
      expect(signal).toBe(controller.signal);
      requested = true;
      return new Promise<never>(() => {});
    },
  });
  const prepare = manager.prepare(f.input, controller.signal);
  await expect.poll(() => requested).toBe(true);
  controller.abort();
  await expect(prepare).rejects.toThrow("managed_workspace_canceled");
});

it("refuses another checkout owner while preparation is waiting and releases ownership after cancellation", async () => {
  const f = await fixture(),
    controller = new AbortController();
  let requested = false;
  const first = new ManagedWorkspaces({
    ...f.options,
    githubToken: async () => {
      requested = true;
      return new Promise<never>(() => {});
    },
  }).prepare(f.input, controller.signal);
  await expect.poll(() => requested).toBe(true);
  await expect(new ManagedWorkspaces(f.options).prepare(f.input, f.signal)).rejects.toThrow(
    "managed_workspace_unavailable",
  );
  controller.abort();
  await expect(first).rejects.toThrow("managed_workspace_canceled");
  expect((await new ManagedWorkspaces(f.options).prepare(f.input, f.signal)).baseCommit).toBe(
    f.head,
  );
});

it("uses the sandbox's named repository folder with control metadata outside it and refuses another task", async () => {
  const f = await fixture(),
    workDirectory = path.join(f.root, "work");
  const options = {
    ...f.options,
    sandbox: { orgId: f.input.orgId, taskId: f.input.taskId, workDirectory },
  };
  const managed = new ManagedWorkspaces(options);
  const [first, repeated] = await Promise.all([
    managed.prepare(f.input, f.signal),
    managed.prepare(f.input, f.signal),
  ]);
  expect(first).toEqual(repeated);
  expect(first.cwd).toBe(path.join(await realpath(workDirectory), "repository"));
  expect(first.baseCommit).toBe(f.head);
  await writeFile(path.join(first.cwd, "test.txt"), "Sandbox edit\n");
  expect(await new ManagedWorkspaces(options).prepare(f.input, f.signal)).toEqual(first);
  expect(await readFile(path.join(first.cwd, "test.txt"), "utf8")).toBe("Sandbox edit\n");
  await expect(readFile(path.join(first.cwd, "binding.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  for (const other of [
    { ...f.input, taskId: "other" },
    { ...f.input, orgId: "other" },
  ])
    await expect(managed.prepare(other, f.signal)).rejects.toThrow(
      "managed_workspace_scope_conflict",
    );
  await expect(
    new ManagedWorkspaces({
      ...options,
      sandbox: { ...options.sandbox, workDirectory: "relative" },
    }).prepare(f.input, f.signal),
  ).rejects.toThrow("managed_workspace_scope_conflict");
});
