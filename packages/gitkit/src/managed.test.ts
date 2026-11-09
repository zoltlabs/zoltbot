import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  changes,
  git,
  integrate,
  ManagedWorktrees,
  previewIntegration,
  repository,
} from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zolt-gitkit-"));
  roots.push(root);
  await git(root, ["init"], true);
  await git(root, ["config", "user.name", "Test"], true);
  await git(root, ["config", "user.email", "test@example.invalid"], true);
  await writeFile(path.join(root, "file"), "base\n");
  await git(root, ["add", "file"], true);
  await git(root, ["commit", "-m", "base"], true);
  return root;
}
test("durable detached preparation preserves dirty source and resumes same folder", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "file"), "dirty\n");
  const storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const manager = new ManagedWorktrees(storage);
  const binding = await manager.prepare("task-1", root);
  expect(await readFile(path.join(binding.cwd, "file"), "utf8")).toBe("base\n");
  expect(await readFile(path.join(root, "file"), "utf8")).toBe("dirty\n");
  expect((await manager.verify(await manager.load(binding.operationId))).cwd).toBe(binding.cwd);
  expect((await repository(binding.cwd)).commonDir).toBe((await repository(root)).commonDir);
});
test("integration fences source and dirty destination, retains backup", async () => {
  const root = await fixture(),
    storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const binding = await new ManagedWorktrees(storage).prepare("task", root);
  await writeFile(path.join(binding.cwd, "file"), "reviewed\n");
  expect((await changes(binding.cwd, binding.baseCommit)).patch).toContain("+reviewed");
  await git(binding.cwd, ["add", "file"], true);
  await git(binding.cwd, ["commit", "-m", "review"], true);
  const head = (await repository(binding.cwd)).head;
  const preview = await previewIntegration(binding.cwd, root, head);
  await writeFile(path.join(root, "untracked"), "keep");
  await expect(integrate(preview, true)).rejects.toThrow("destination_dirty");
  await rm(path.join(root, "untracked"));
  const result = await integrate(preview, true);
  expect(result.head).toBe(head);
  expect(await git(root, ["rev-parse", result.backupRef])).toBe(binding.baseCommit);
});

test("rejects active hooks before checkout mutation and option-like refs", async () => {
  const root = await fixture();
  const storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const manager = new ManagedWorktrees(storage);
  await expect(manager.prepare("task", root, "--upload-pack=bad")).rejects.toThrow("invalid_ref");
  const { chmod } = await import("node:fs/promises");
  const hook = path.join(root, ".git/hooks/post-checkout");
  await writeFile(hook, "#!/bin/sh\necho bad > sentinel\n");
  await chmod(hook, 0o755);
  await expect(manager.prepare("task", root)).rejects.toThrow("hook_execution_approval_required");
  expect(await git(root, ["worktree", "list", "--porcelain"])).not.toContain(storage);
});

test("destination movement requires new preview and does not write destination", async () => {
  const root = await fixture(),
    storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const binding = await new ManagedWorktrees(storage).prepare("task", root);
  await writeFile(path.join(binding.cwd, "source"), "source");
  await git(binding.cwd, ["add", "source"], true);
  await git(binding.cwd, ["commit", "-m", "source"], true);
  const preview = await previewIntegration(binding.cwd, root, (await repository(binding.cwd)).head);
  await writeFile(path.join(root, "destination"), "destination");
  await git(root, ["add", "destination"], true);
  await git(root, ["commit", "-m", "destination"], true);
  const before = await repository(root);
  await expect(integrate(preview, true)).rejects.toThrow("update_task_from_destination_required");
  expect((await repository(root)).head).toBe(before.head);
  expect(await git(root, ["status", "--porcelain"])).toBe("");
});

test("review preview includes staged and untracked files, fences changes and excludes secrets", async () => {
  const { previewReview, createReviewCommit } = await import("./review.js");
  const root = await fixture();
  await writeFile(path.join(root, "file"), "review\n");
  await writeFile(path.join(root, "new"), "new\n");
  const base = (await repository(root)).head;
  const preview = await previewReview(root, base);
  expect(preview.files.map((file) => file.path)).toEqual(["file", "new"]);
  await writeFile(path.join(root, "new"), "changed\n");
  await expect(createReviewCommit(preview, "review", true)).rejects.toThrow("review_preview_stale");
  await writeFile(path.join(root, ".env"), "SECRET=private\n");
  const excluded = await previewReview(root, base);
  expect(excluded.files.find((file) => file.path === ".env")?.excluded).toContain(
    "Potential secret",
  );
  await expect(createReviewCommit(excluded, "review", true)).rejects.toThrow(
    "review_files_excluded",
  );
  await rm(path.join(root, ".env"));
  const result = await createReviewCommit(await previewReview(root, base), "review", true);
  expect(result.head).not.toBe(base);
  expect(await git(root, ["status", "--porcelain"])).toBe("");
});

test("verified bundle survives archive and restores detached committed work", async () => {
  const root = await fixture(),
    storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const manager = new ManagedWorktrees(storage),
    binding = await manager.prepare("task", root);
  await writeFile(path.join(binding.cwd, "result"), "preserved\n");
  await git(binding.cwd, ["add", "result"], true);
  await git(binding.cwd, ["commit", "-m", "result"], true);
  const archived = await manager.archive(binding.operationId, true);
  expect(archived.state).toBe("archived");
  expect(archived.archive?.verified).toBe(true);
  await git(root, ["reflog", "expire", "--expire=now", "--all"], true);
  await git(root, ["gc", "--prune=now"], true);
  const restored = await manager.restore(binding.operationId, true);
  expect(restored.state).toBe("ready");
  expect(await readFile(path.join(restored.cwd, "result"), "utf8")).toBe("preserved\n");
});

test("reconciles a preparation intent before Git mutation using the original frozen base", async () => {
  const root = await fixture(),
    storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const repo = await repository(root),
    operationId = "crash-boundary";
  await writeFile(
    path.join(storage, `${operationId}.json`),
    JSON.stringify({
      operationId,
      taskId: "task",
      cwd: path.join(await realpath(storage), operationId),
      repository: repo.root,
      commonDir: repo.commonDir,
      baseCommit: repo.head,
      state: "preparing",
    }),
  );
  await writeFile(path.join(root, "file"), "new destination\n");
  await git(root, ["add", "file"], true);
  await git(root, ["commit", "-m", "moved"], true);
  const recovered = await new ManagedWorktrees(storage).prepare("task", root, "HEAD", operationId);
  expect(recovered.baseCommit).toBe(repo.head);
  expect((await repository(recovered.cwd)).head).toBe(repo.head);
});

test("reconciles metadata created before ready intent and refuses a replaced worktree", async () => {
  const root = await fixture(),
    storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const manager = new ManagedWorktrees(storage),
    binding = await manager.prepare("task", root);
  await writeFile(
    path.join(storage, `${binding.operationId}.json`),
    JSON.stringify({ ...binding, state: "preparing" }),
  );
  expect(
    (await new ManagedWorktrees(storage).verify(await manager.load(binding.operationId))).state,
  ).toBe("ready");
  await git(root, ["worktree", "remove", "--", binding.cwd], true);
  await expect(manager.verify(await manager.load(binding.operationId))).rejects.toThrow(
    "workspace_missing",
  );
  const { symlink } = await import("node:fs/promises");
  await symlink(root, binding.cwd);
  await expect(manager.verify(await manager.load(binding.operationId))).rejects.toThrow(
    "workspace_replaced",
  );
});

test("approved checkout hooks execute normally and failed setup is never adopted as ready", async () => {
  const { preparationExecutionHash } = await import("./hooks.js");
  const { chmod } = await import("node:fs/promises");
  const root = await fixture(),
    storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const hook = path.join(root, ".git/hooks/post-checkout");
  await writeFile(hook, "#!/bin/sh\nprintf 'setup ran' > setup-result\n");
  await chmod(hook, 0o755);
  const repo = await repository(root),
    manager = new ManagedWorktrees(storage);
  const approved = await manager.prepare(
    "approved",
    root,
    repo.head,
    "approved",
    await preparationExecutionHash(root, repo.head),
  );
  expect(await readFile(path.join(approved.cwd, "setup-result"), "utf8")).toBe("setup ran");
  await writeFile(hook, "#!/bin/sh\nprintf 'failed but kept' > setup-result\nexit 1\n");
  await expect(
    manager.prepare(
      "failed",
      root,
      repo.head,
      "failed",
      await preparationExecutionHash(root, repo.head),
    ),
  ).rejects.toThrow("git_failed");
  expect(await readFile(path.join(storage, "failed/setup-result"), "utf8")).toBe("failed but kept");
  await expect(
    manager.prepare(
      "failed",
      root,
      repo.head,
      "failed",
      await preparationExecutionHash(root, repo.head),
    ),
  ).rejects.toThrow("workspace_setup_failed");
});

test("archive retains rewritten commits from the task reflog as well as its original base", async () => {
  const root = await fixture(),
    storage = await mkdtemp(path.join(os.tmpdir(), "zolt-managed-"));
  roots.push(storage);
  const manager = new ManagedWorktrees(storage),
    binding = await manager.prepare("task", root);
  await writeFile(path.join(binding.cwd, "file"), "earlier work\n");
  await git(binding.cwd, ["add", "file"], true);
  await git(binding.cwd, ["commit", "-m", "earlier"], true);
  const earlier = (await repository(binding.cwd)).head;
  await git(binding.cwd, ["checkout", "--detach", binding.baseCommit], true);
  await writeFile(path.join(binding.cwd, "file"), "current work\n");
  await git(binding.cwd, ["add", "file"], true);
  await git(binding.cwd, ["commit", "-m", "current"], true);
  const archived = await manager.archive(binding.operationId, true);
  expect(archived.archive?.commits).toContain(earlier);
  await git(root, ["reflog", "expire", "--expire=now", "--all"], true);
  await git(root, ["gc", "--prune=now"], true);
  await manager.restore(binding.operationId, true);
  expect(await git(root, ["cat-file", "-t", earlier])).toBe("commit");
  expect(await readFile(path.join(binding.cwd, "file"), "utf8")).toBe("current work\n");
});

test("review files preserve rename names, binary, empty and large states and distinguish scopes", async () => {
  const root = await fixture();
  const base = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["mv", "file", "renamed\tfile"], true);
  await git(root, ["commit", "-m", "rename"], true);
  await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "empty"), "");
  await writeFile(path.join(root, "large"), "x\n".repeat(13000));
  await git(root, ["add", "."], true);
  await writeFile(path.join(root, "untracked.txt"), "private draft");
  const statusBefore = await git(root, ["status", "--porcelain=v1"]);
  const result = await changes(root, base);
  expect(await git(root, ["status", "--porcelain=v1"])).toBe(statusBefore);
  expect(result.files.find((file) => file.path === "untracked.txt")?.unavailable).toContain(
    "Untracked",
  );
  expect(result.files.find((file) => file.path === "renamed\tfile")?.previousPath).toBe("file");
  expect(result.uncommittedFiles.some((file) => file.path === "renamed\tfile")).toBe(false);
  expect(result.files.find((file) => file.path === "binary")?.binary).toBe(true);
  expect(result.files.find((file) => file.path === "empty")?.added).toBe(0);
  expect(result.files.find((file) => file.path === "large")?.unavailable).toContain("Large diff");
  expect(await git(root, ["rev-parse", "HEAD"])).toBe(result.head);
  expect(await git(root, ["status", "--porcelain=v1"])).toContain("large");
});
