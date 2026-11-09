import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { scopeLineage } from "@zoltbot/core";
import type { ForkProvenance } from "@zoltbot/protocol";
import { ProjectSchema, parse, TaskSchema, WorkspaceSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { canonicalApprovalRoot } from "./approval-paths.js";
import {
  chiefInstructions,
  chiefName,
  chiefThreadId,
  leadIdeasInstruction,
} from "./chief/identity.js";
import type { NativeRuntimeOptions } from "./native-runtime.js";
import { worktreeService } from "./worktree-service.js";

function directory(file: string, create = false): string {
  try {
    if (create) {
      try {
        mkdirSync(file, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const info = lstatSync(file);
    const root = canonicalApprovalRoot(file);
    if (info.isSymbolicLink() || !info.isDirectory() || !root || root.path !== file)
      throw new Error();
    if (create) chmodSync(file, 0o700);
    return root.path;
  } catch {
    throw new Error("runtime_workspace_unavailable");
  }
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    !relative ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}
export function runtimeWorkspace(options: {
  store: Pick<Store, "snapshot">;
  directory: string;
}): NativeRuntimeOptions["workspace"] {
  return async (input) => {
    const state = options.store.snapshot([
      "thread",
      "agent",
      "project",
      "subproject",
      "task",
      "workspace",
      "settings",
    ]);
    const thread = state.thread?.find((row) => row.id === input.thread.id && !row.archived);
    if (
      !thread ||
      thread.agentId !== input.profile.id ||
      !state.agent?.some((row) => row.id === thread.agentId && !row.archived)
    )
      throw new Error("runtime_thread_unavailable");
    if (thread.projectId !== input.thread.projectId || thread.taskId !== input.thread.taskId)
      throw new Error("runtime_configuration_changed");
    const selectedProject = state.project?.find(
      (row) => row.id === thread.projectId && !row.archived,
    );
    if (thread.projectId && !selectedProject) throw new Error("runtime_workspace_unavailable");
    const project = selectedProject ? parse(ProjectSchema, selectedProject) : undefined;
    const lineage =
      thread.node || project
        ? scopeLineage(state, thread.node ?? { type: "project", id: project?.id })
        : undefined;
    if (lineage && lineage.project.id !== thread.projectId)
      throw new Error("scope_project_mismatch");
    const instructions = lineage
      ? [lineage.project, ...lineage.directions]
          .map((row, index) => {
            const parts = [
              row.goal ? `Goal: ${row.goal}` : "",
              row.instructions ? `Instructions: ${row.instructions}` : "",
              "constraints" in row && row.constraints ? `Constraints: ${row.constraints}` : "",
            ].filter(Boolean);
            return parts.length
              ? `${index ? "Team" : "Workspace"}: ${row.name}\n${parts.join("\n")}`
              : "";
          })
          .filter(Boolean)
          .join("\n\n")
      : chiefThreadId(state) === thread.id
        ? chiefInstructions(chiefName(state))
        : "";
    // Leads bring back what they noticed outside their brief.
    const ideas =
      lineage && thread.kind === "manager" && chiefThreadId(state) ? leadIdeasInstruction : "";
    const fork = thread.fork as ForkProvenance | undefined;
    if (fork) {
      const root = canonicalApprovalRoot(fork.cwd);
      if (!root || root.path !== fork.cwd) throw Error("runtime_workspace_changed");
      if (fork.workspaceId) {
        const workspace = state.workspace?.find((r) => r.id === fork.workspaceId);
        if (
          !workspace ||
          workspace.state !== "active" ||
          workspace.path !== root.path ||
          workspace.projectId !== thread.projectId
        )
          throw Error("runtime_workspace_unavailable");
        if (workspace.kind === "worktree") {
          const frozen = await worktreeService(options.directory).contribution(fork.workspaceId);
          if (frozen.cwd !== root.path || frozen.baseCommit !== workspace.baseRef)
            throw Error("runtime_workspace_changed");
        }
      }
      return { cwd: root.path, instructions: [instructions, ideas].filter(Boolean).join("\n\n") };
    }
    let cwd: string;
    const selectedTask = thread.taskId
      ? state.task?.find((row) => row.id === thread.taskId)
      : undefined;
    if (thread.taskId && !selectedTask) throw new Error("runtime_workspace_choice_required");
    const task = selectedTask ? parse(TaskSchema, selectedTask) : undefined;
    if (
      task &&
      (task.threadId !== thread.id ||
        task.ownerAgentId !== input.profile.id ||
        task.projectId !== thread.projectId)
    )
      throw new Error("runtime_workspace_choice_required");
    // D122: a shared task without its own workspace uses the same folder as a chat.
    if (task && (task.workspaceId || task.workspaceMode === "worktree")) {
      if (!task.workspaceId) throw new Error("runtime_workspace_choice_required");
      const selectedWorkspace = state.workspace?.find((row) => row.id === task.workspaceId);
      if (!selectedWorkspace) throw new Error("runtime_workspace_unavailable");
      const workspace = parse(WorkspaceSchema, selectedWorkspace);
      if (workspace.state !== "active" || workspace.projectId !== thread.projectId)
        throw new Error("runtime_workspace_unavailable");
      const root = canonicalApprovalRoot(workspace.path);
      if (!root) throw new Error("runtime_workspace_unavailable");
      if (workspace.kind === "worktree") {
        const frozen = await worktreeService(options.directory).contribution(workspace.id);
        if (frozen.cwd !== root.path || frozen.baseCommit !== workspace.baseRef)
          throw new Error("runtime_workspace_changed");
      }
      cwd = root.path;
    } else if (project?.roots.length) {
      if (project.roots.length > 100) throw new Error("runtime_workspace_choice_required");
      const roots = new Set(
        project.roots.map(({ path: folder }) => {
          const root = canonicalApprovalRoot(folder);
          if (!root) throw new Error("runtime_workspace_unavailable");
          return root.path;
        }),
      );
      if (input.previous) {
        const previous = canonicalApprovalRoot(input.previous.cwd);
        if (!previous) throw new Error("runtime_workspace_unavailable");
        if (
          previous.path !== input.previous.cwd ||
          ![...roots].some((root) => within(root, previous.path))
        )
          throw new Error("native_cwd_changed");
        cwd = previous.path;
      } else {
        if (roots.size !== 1) throw new Error("runtime_workspace_choice_required");
        cwd = [...roots][0] as string;
      }
    } else {
      const root = canonicalApprovalRoot(options.directory);
      if (!root) throw new Error("runtime_workspace_unavailable");
      const create = input.previous === undefined;
      const base = directory(path.join(root.path, "workspaces"), create);
      const key = createHash("sha256").update(input.thread.id).digest("hex");
      const selected = path.join(base, key);
      if (input.previous && input.previous.cwd !== selected) throw new Error("native_cwd_changed");
      cwd = directory(selected, create);
    }
    if (input.previous && input.previous.cwd !== cwd) throw new Error("native_cwd_changed");
    const text = [instructions, ideas].filter(Boolean).join("\n\n");
    return { cwd, ...(text ? { instructions: text } : {}) };
  };
}
