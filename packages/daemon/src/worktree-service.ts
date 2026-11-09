import { createHash } from "node:crypto";
import path from "node:path";
import { type DomainState, scopeLineage } from "@zoltbot/core";
import type { Store } from "@zoltbot/store";
import { preparationExecutionHash } from "../../gitkit/src/hooks.js";
import {
  commit,
  ManagedWorktrees,
  repository,
  type WorkspaceBinding,
} from "../../gitkit/src/index.js";

export function worktreeService(directory: string, store?: Pick<Store, "database">) {
  const manager = new ManagedWorktrees(path.join(directory, "managed-worktrees"), (binding) => {
    if (
      !store?.database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='managed_worktree_operations'",
        )
        .get()
    )
      return;
    store.database
      .prepare(`INSERT INTO managed_worktree_operations(id,task_id,workspace_id,repository,base_commit,state,body,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,body=excluded.body,updated_at=excluded.updated_at`)
      .run(
        binding.operationId,
        binding.taskId,
        binding.operationId,
        binding.repository,
        binding.baseCommit,
        binding.state,
        JSON.stringify(binding),
        new Date().toISOString(),
      );
  });
  return {
    manager,
    async proposal(
      state: DomainState,
      node: { type: string; id: string },
      taskId: string,
      ref = "HEAD",
    ) {
      const project = scopeLineage(state, node).project;
      const roots = project.roots as { path: string }[];
      if (roots.length !== 1) throw new Error("worktree_single_git_root_required");
      const repo = await repository(roots[0]?.path ?? "");
      const base = await commit(repo.root, ref);
      const operationId = createHash("sha256").update(taskId).digest("hex");
      return {
        base,
        cwd: path.join(manager.storage, operationId),
        repository: repo.root,
        executionHash: await preparationExecutionHash(repo.root, base),
      };
    },
    async prepare(
      state: DomainState,
      node: { type: string; id: string },
      taskId: string,
      base = "HEAD",
      approvedExecutionHash?: string,
    ) {
      const project = scopeLineage(state, node).project;
      const roots = project.roots as { path: string }[];
      if (roots.length !== 1) throw new Error("worktree_single_git_root_required");
      const operationId = createHash("sha256").update(taskId).digest("hex");
      return manager.prepare(
        taskId,
        roots[0]?.path ?? "",
        base,
        operationId,
        approvedExecutionHash,
      );
    },
    async contribution(operationId: string): Promise<{ cwd: string; baseCommit: string }> {
      const binding = await manager.verify(await manager.load(operationId));
      return { cwd: binding.cwd, baseCommit: binding.baseCommit };
    },
  };
}
export function workspaceRecord(binding: WorkspaceBinding, projectId: string, at: string) {
  return {
    id: binding.operationId,
    projectId,
    kind: "worktree",
    path: binding.cwd,
    repoRoot: binding.repository,
    baseRef: binding.baseCommit,
    state: "active",
    createdAt: at,
  };
}
