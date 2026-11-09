import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { archiveSnapshot } from "./archive.js";
import { commit, git, repository, repositoryLock } from "./git.js";
import {
  preparationExecutionHash,
  rejectActiveHook,
  rejectCheckoutFilters,
  rejectNestedRepositories,
} from "./hooks.js";

export interface WorkspaceBinding {
  operationId: string;
  taskId: string;
  cwd: string;
  repository: string;
  commonDir: string;
  baseCommit: string;
  state: "preparing" | "ready" | "missing" | "failed" | "archiving" | "archived";
  setupExecutionHash?: string;
  archive?: { path: string; head: string; base: string; verified: true; commits?: string[] };
}
/** Private intent storage is supplied by the daemon, never inside a user checkout. */
export class ManagedWorktrees {
  constructor(
    readonly storage: string,
    readonly onIntent?: (binding: WorkspaceBinding) => void,
  ) {}
  private intent(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid_operation_id");
    return path.join(this.storage, `${id}.json`);
  }
  private async save(binding: WorkspaceBinding) {
    const target = this.intent(binding.operationId),
      temporary = `${target}.${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(binding), { mode: 0o600 });
    await rename(temporary, target);
    this.onIntent?.(binding);
  }
  async load(id: string): Promise<WorkspaceBinding> {
    return JSON.parse(await readFile(this.intent(id), "utf8")) as WorkspaceBinding;
  }
  async prepare(
    taskId: string,
    folder: string,
    ref = "HEAD",
    operationId: string = randomUUID(),
    approvedExecutionHash?: string,
  ): Promise<WorkspaceBinding> {
    await mkdir(this.storage, { recursive: true, mode: 0o700 });
    const repo = await repository(folder);
    const baseCommit = await commit(repo.root, ref);
    await rejectNestedRepositories(repo.root);
    const approved =
      approvedExecutionHash === (await preparationExecutionHash(repo.root, baseCommit));
    if (!approved) {
      await rejectActiveHook(repo.root, "post-checkout");
      await rejectCheckoutFilters(repo.root, baseCommit);
    }
    const binding: WorkspaceBinding = {
      operationId,
      taskId,
      cwd: path.join(await realpath(this.storage), operationId),
      repository: repo.root,
      commonDir: repo.commonDir,
      baseCommit,
      state: "preparing",
      ...(approvedExecutionHash ? { setupExecutionHash: approvedExecutionHash } : {}),
    };
    this.intent(operationId);
    return repositoryLock(repo.commonDir, async () => {
      try {
        await lstat(this.intent(operationId));
        const previous = await this.load(operationId);
        if (previous.taskId !== taskId || previous.repository !== repo.root)
          throw new Error("workspace_owner_mismatch");
        const priorState = previous.state;
        if (
          priorState === "failed" ||
          (priorState === "preparing" && previous.setupExecutionHash)
        ) {
          try {
            await lstat(previous.cwd);
            throw new Error(
              priorState === "failed" ? "workspace_setup_failed" : "workspace_setup_uncertain",
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        try {
          return await this.verify(previous);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "workspace_missing" ||
            !["preparing", "failed"].includes(priorState)
          )
            throw error;
          Object.assign(binding, previous, { state: "preparing" });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.save(binding); // durable before Git mutates metadata
      try {
        const executionApproved =
          approvedExecutionHash === (await preparationExecutionHash(repo.root, binding.baseCommit));
        if (!executionApproved) {
          for (const hook of ["post-checkout", "post-index-change", "reference-transaction"])
            await rejectActiveHook(repo.root, hook);
          await rejectCheckoutFilters(repo.root, binding.baseCommit);
        }
        await git(
          repo.root,
          ["worktree", "add", "--detach", "--", binding.cwd, binding.baseCommit],
          true,
        );
        binding.state = "ready";
        await this.save(binding);
        return binding;
      } catch (error) {
        binding.state = "failed";
        await this.save(binding);
        throw error;
      }
    });
  }
  async archive(operationId: string, confirmed: boolean): Promise<WorkspaceBinding> {
    if (!confirmed) throw new Error("confirmation_required");
    const binding = await this.load(operationId);
    return repositoryLock(binding.commonDir, async () => {
      await this.verify(binding);
      const snapshot = await archiveSnapshot(
        binding.cwd,
        binding.baseCommit,
        path.join(this.storage, "archives"),
      );
      binding.archive = snapshot;
      binding.state = "archiving";
      await this.save(binding);
      // No force: Git must also agree that no work would be discarded.
      await git(binding.repository, ["worktree", "remove", "--", binding.cwd], true);
      binding.state = "archived";
      await this.save(binding);
      return binding;
    });
  }
  async restore(operationId: string, confirmed: boolean): Promise<WorkspaceBinding> {
    if (!confirmed) throw new Error("confirmation_required");
    const binding = await this.load(operationId);
    if (binding.state !== "archived" || !binding.archive) throw new Error("workspace_not_archived");
    return repositoryLock(binding.commonDir, async () => {
      for (const hook of ["post-checkout", "post-index-change", "reference-transaction"])
        await rejectActiveHook(binding.repository, hook);
      await git(binding.repository, ["bundle", "verify", binding.archive?.path ?? ""]);
      await git(binding.repository, ["bundle", "unbundle", binding.archive?.path ?? ""], true);
      await rejectCheckoutFilters(binding.repository, binding.archive?.head ?? "");
      await git(
        binding.repository,
        ["worktree", "add", "--detach", "--", binding.cwd, binding.archive?.head ?? ""],
        true,
      );
      binding.state = "ready";
      return this.verify(binding);
    });
  }
  async verify(binding: WorkspaceBinding): Promise<WorkspaceBinding> {
    if (binding.state === "archived") throw new Error("workspace_archived");
    const expected = path.join(await realpath(this.storage), binding.operationId);
    if (binding.cwd !== expected) throw new Error("workspace_unowned");
    try {
      if ((await lstat(binding.cwd)).isSymbolicLink()) throw new Error("workspace_replaced");
      const repo = await repository(binding.cwd);
      if (repo.root !== binding.cwd || repo.commonDir !== binding.commonDir)
        throw new Error("workspace_replaced");
      const registered = await git(binding.repository, ["worktree", "list", "--porcelain"]);
      if (!registered.split("\n").includes(`worktree ${binding.cwd}`))
        throw new Error("workspace_unowned");
      binding.state = "ready";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      binding.state = "missing";
    }
    await this.save(binding);
    if (binding.state !== "ready") throw new Error("workspace_missing");
    return binding;
  }
}
