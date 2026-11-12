import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { managedReviews } from "./managed-review.js";
import { ManagedWorkspaces } from "./workspaces.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
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
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function fixture() {
  const root = await mkdtemp("/private/tmp/zoltbot-managed-review-");
  roots.push(root);
  const source = path.join(root, "source"),
    remote = path.join(root, "remote.git");
  await mkdir(source);
  git(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "file.txt"), "Initial content\n");
  git(source, ["add", "."]);
  git(source, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Initial",
  ]);
  git(root, ["clone", "--bare", source, remote]);
  const scope = {
    orgId: "org",
    taskId: "task",
    repository: "example/repository",
    defaultBranch: "main",
  };
  const workspaces = new ManagedWorkspaces({
    directory: path.join(root, "managed"),
    localRepository: () => remote,
  });
  const controller = new AbortController(),
    workspace = await workspaces.prepare(scope, controller.signal);
  const options = {
    workspaces,
    scope,
    signal: controller.signal,
    assertPublic: async (_value: unknown) => {},
  };
  return {
    root,
    workspace,
    controller,
    options,
    review: managedReviews(options),
    head: () => git(workspace.cwd, ["rev-parse", "HEAD"]),
  };
}
it("prepares exact approved blobs without advancing HEAD and finishes once across a reopened capability", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "Reviewed content\n");
  await writeFile(path.join(f.workspace.cwd, "new.txt"), "New reviewed file\n");
  const previous = f.head(),
    preview = await f.review.preview();
  expect(JSON.stringify(f.review)).toBe("{}");
  expect(JSON.stringify(preview).includes(f.workspace.cwd)).toBe(false);
  expect(preview.files.map((file) => file.path)).toEqual(["file.txt", "new.txt"]);
  const prepared = await f.review.prepareCommit(preview.fingerprint);
  expect(f.head()).toBe(previous);
  const reopened = managedReviews(f.options),
    result = await reopened.finish(prepared);
  expect(result).toMatchObject({ previous, head: prepared.head });
  expect(await reopened.finish(prepared)).toEqual(result);
  expect(git(f.workspace.cwd, ["rev-list", "--count", "HEAD"])).toBe("2");
  expect(git(f.workspace.cwd, ["show", "HEAD:new.txt"])).toBe("New reviewed file");
  expect(git(f.workspace.cwd, ["show", "-s", "--format=%an <%ae>", "HEAD"])).toBe(
    "Zolt Labs <zolt@zoltbot.ai>",
  );
  expect(git(f.workspace.cwd, ["status", "--porcelain"])).toBe("");
});
it("refuses a changed preview and does not replace a concurrently advanced branch", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "First preview\n");
  const preview = await f.review.preview();
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "Changed content\n");
  await expect(f.review.prepareCommit(preview.fingerprint)).rejects.toThrow("review_preview_stale");
  const prepared = await f.review.prepareCommit((await f.review.preview()).fingerprint);
  git(f.workspace.cwd, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "Concurrent commit",
  ]);
  const other = f.head();
  await expect(f.review.finish(prepared)).rejects.toThrow("review_preview_stale");
  expect(f.head()).toBe(other);
});
it("checks private content before writing Git objects and excludes secret-shaped filenames and escaping links", async () => {
  const f = await fixture();
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "Classified fixture content\n");
  const before = git(f.workspace.cwd, ["count-objects", "-v"]);
  const review = managedReviews({
    ...f.options,
    assertPublic: async (value) => {
      if (typeof value === "string" && value.includes("Classified fixture content"))
        throw new Error("private_context");
    },
  });
  await expect(review.preview()).rejects.toThrow("private_context");
  expect(git(f.workspace.cwd, ["count-objects", "-v"])).toBe(before);
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "Public fixture content\n");
  await writeFile(path.join(f.workspace.cwd, ".env"), "Example configuration\n");
  await symlink(path.join(f.root, "source/file.txt"), path.join(f.workspace.cwd, "external"));
  const preview = await f.review.preview();
  expect(preview.files.filter((file) => file.excluded).map((file) => file.path)).toEqual([
    ".env",
    "external",
  ]);
  await expect(f.review.prepareCommit(preview.fingerprint)).rejects.toThrow(
    "review_files_excluded",
  );
  expect(f.head()).toBe(f.workspace.baseCommit);
});
it("commits the captured approved bytes while later worktree changes remain uncommitted", async () => {
  const f = await fixture(),
    file = path.join(f.workspace.cwd, "file.txt");
  await writeFile(file, "Reviewed snapshot\n");
  const preview = await f.review.preview();
  let changed = false;
  const review = managedReviews({
    ...f.options,
    assertPublic: async (value) => {
      if (!changed && value === "Reviewed snapshot\n") {
        changed = true;
        await writeFile(file, "Later unreviewed changes\n");
      }
    },
  });
  const prepared = await review.prepareCommit(preview.fingerprint);
  await review.finish(prepared);
  expect(git(f.workspace.cwd, ["show", "HEAD:file.txt"])).toBe("Reviewed snapshot");
  expect(await readFile(file, "utf8")).toBe("Later unreviewed changes\n");
  expect(git(f.workspace.cwd, ["status", "--porcelain"])).not.toBe("");
});
it("includes deletions and executable bits in the reviewed snapshot", async () => {
  const f = await fixture();
  await rm(path.join(f.workspace.cwd, "file.txt"));
  const script = path.join(f.workspace.cwd, "run.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  await chmod(script, 0o600);
  const before = await f.review.preview();
  await chmod(script, 0o700);
  await expect(f.review.prepareCommit(before.fingerprint)).rejects.toThrow("review_preview_stale");
  const preview = await f.review.preview();
  expect(preview.files.find((file) => file.path === "file.txt")?.hash).toBe("deleted");
  const prepared = await f.review.prepareCommit(preview.fingerprint);
  await f.review.finish(prepared);
  expect(git(f.workspace.cwd, ["ls-tree", "HEAD"])).toContain("100755 blob");
  expect(git(f.workspace.cwd, ["ls-tree", "HEAD"])).not.toContain("file.txt");
});
it("disables commit hooks and refuses configured filters instead of executing them", async () => {
  const f = await fixture();
  const marker = path.join(f.root, "hook-ran"),
    hook = path.join(f.workspace.cwd, ".git/hooks/pre-commit");
  await mkdir(path.dirname(hook), { recursive: true });
  await writeFile(hook, `#!/bin/sh\nprintf called > '${marker}'\n`);
  await chmod(hook, 0o700);
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "Reviewed content\n");
  const prepared = await f.review.prepareCommit((await f.review.preview()).fingerprint);
  await f.review.finish(prepared);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  git(f.workspace.cwd, ["config", "filter.untrusted.clean", "false"]);
  await expect(f.review.preview()).rejects.toThrow();
});

it("keeps repository identity and encoding values out of commit and reflog metadata", async () => {
  const f = await fixture();
  git(f.workspace.cwd, ["config", "user.name", "Classified fixture identity"]);
  git(f.workspace.cwd, ["config", "user.email", "fixture@example.invalid"]);
  git(f.workspace.cwd, ["config", "i18n.commitEncoding", "Classified fixture encoding"]);
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "Reviewed content\n");
  const prepared = await f.review.prepareCommit((await f.review.preview()).fingerprint);
  await f.review.finish(prepared);
  expect(git(f.workspace.cwd, ["cat-file", "-p", "HEAD"])).not.toContain("Classified fixture");
  expect(await readFile(path.join(f.workspace.cwd, ".git/logs/HEAD"), "utf8")).not.toContain(
    "Classified fixture",
  );
});

it("checks branch metadata before it can enter a prepared commit journal", async () => {
  const f = await fixture();
  git(f.workspace.cwd, ["switch", "-c", "fixture-classified-reference"]);
  await writeFile(path.join(f.workspace.cwd, "file.txt"), "Reviewed content\n");
  const review = managedReviews({
    ...f.options,
    assertPublic: async (value) => {
      if (JSON.stringify(value).includes("fixture-classified-reference"))
        throw new Error("private_context");
    },
  });
  await expect(review.preview()).rejects.toThrow("private_context");
  expect(f.head()).toBe(f.workspace.baseCommit);
});
