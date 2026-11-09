import { applyEvents, handle, holdTask } from "@zoltbot/core";
import {
  type DomainEvent,
  HOST_WORKSPACE_REF,
  type InteractionDraft,
  parse,
  TaskSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { canonicalApprovalRoot } from "./approval-paths.js";
import type { worktreeService } from "./worktree-service.js";

export async function prepareTaskWorktree(options: {
  store: Store;
  worktrees: ReturnType<typeof worktreeService>;
  taskId: string;
  publish(events: DomainEvent[]): void;
  requestApproval?(draft: InteractionDraft, commandId: string): Promise<unknown>;
}) {
  const { store, worktrees, taskId } = options;
  const task = parse(TaskSchema, store.record("task", taskId));
  if (task.workspaceMode !== "worktree" || task.workspaceId || task.state !== "queued") return task;
  if (!task.node) throw new Error("scope_required");
  let proposal: Awaited<ReturnType<typeof worktrees.proposal>> | undefined;
  let approvalId = "";
  try {
    proposal = await worktrees.proposal(
      store.snapshot(),
      task.node,
      task.id,
      task.baseRef ?? "HEAD",
    );
    const freezeId = `worktree:base:${task.id}`;
    const beforeFreeze = store.lastSeq();
    store.dispatch(freezeId, (state) =>
      handle(
        state,
        { type: "update", kind: "task", id: task.id, changes: { baseRef: proposal?.base } },
        {
          commandId: freezeId,
          at: new Date().toISOString(),
          actor: { kind: "system", id: "worktrees" },
        },
      ),
    );
    options.publish(store.eventsSince(beforeFreeze));
    approvalId = `worktree-prepare-${task.id}-${proposal.executionHash}`;
    const approval = store.record("interaction", approvalId);
    const resolution = approval?.resolution as
      | { action?: string; choice?: string; automatic?: boolean }
      | undefined;
    const executionHash =
      approval?.state === "answered" &&
      resolution?.action === "accept" &&
      resolution.choice === "allow_once" &&
      !resolution.automatic
        ? proposal.executionHash
        : undefined;
    const binding = await worktrees.prepare(
      store.snapshot(),
      task.node,
      task.id,
      proposal.base,
      executionHash,
    );
    const commandId = `worktree:bind:${task.id}`;
    const before = store.lastSeq();
    const receipt = store.dispatch(commandId, (state) => {
      const latest = parse(
        TaskSchema,
        state.task?.find((row) => row.id === task.id),
      );
      if (latest.state !== "queued" || latest.workspaceId || latest.revision !== task.revision)
        throw new Error("task_changed_during_preparation");
      const roots = state.project?.find((row) => row.id === task.projectId)?.roots as
        | { path: string }[]
        | undefined;
      if (
        roots?.length !== 1 ||
        canonicalApprovalRoot(roots[0]?.path ?? "")?.path !== binding.repository
      )
        throw new Error("project_changed_during_preparation");
      const context = {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "system" as const, id: "worktrees" },
      };
      const workspace = handle(
        state,
        {
          type: "create",
          kind: "workspace",
          value: {
            id: binding.operationId,
            projectId: task.projectId,
            kind: "worktree",
            path: binding.cwd,
            repoRoot: binding.repository,
            baseRef: binding.baseCommit,
            state: "active",
            createdAt: context.at,
          },
        },
        context,
      );
      const bound = handle(
        applyEvents(state, workspace.events),
        {
          type: "update",
          kind: "task",
          id: task.id,
          changes: { workspaceId: binding.operationId, baseRef: binding.baseCommit },
        },
        context,
      );
      return {
        result: bound.result,
        events: [...workspace.events, ...bound.events].map((event, index) => ({
          ...event,
          eventId: `${commandId}:${index}`,
        })),
      };
    });
    options.publish(store.eventsSince(before));
    return parse(TaskSchema, receipt.result);
  } catch (error) {
    const code =
      (error instanceof Error ? error.message : "").split(":")[0] ?? "worktree_prepare_failed";
    const safe = /^[a-z_]{1,80}$/.test(code) ? code : "worktree_prepare_failed";
    if (
      proposal &&
      task.ownerAgentId &&
      task.threadId &&
      options.requestApproval &&
      ["hook_execution_approval_required", "checkout_filter_execution_approval_required"].includes(
        safe,
      )
    ) {
      await options.requestApproval(
        {
          id: approvalId,
          agentId: task.ownerAgentId,
          threadId: task.threadId,
          taskId: task.id,
          type: "approval",
          title: "Prepare separate worktree",
          nativeRef: HOST_WORKSPACE_REF,
          urgency: "background",
          chain: [{ kind: "human", id: "local-owner" }],
          context: {
            command: `git worktree add --detach -- ${JSON.stringify(proposal.cwd)} ${proposal.base}`,
            cwd: proposal.repository,
            toolName: "worktree_prepare",
            toolKind: "execute",
            markdown:
              "Git checkout may execute configured hooks and smudge filters. This approval applies only to the displayed base and configuration.",
            toolInput: {
              worktreeExecution: true,
              executionHash: proposal.executionHash,
              base: proposal.base,
            },
          },
          items: [
            {
              id: "execute",
              prompt: "Allow Git worktree preparation and its configured hooks/filters?",
              choices: [{ id: "allow_once" }, { id: "reject_once" }],
            },
          ],
        },
        `request:${approvalId}`,
      );
    }
    const commandId = `worktree:hold:${task.id}:${Date.now()}`;
    const before = store.lastSeq();
    store.dispatch(commandId, (state) =>
      holdTask(
        state,
        task.id,
        `Worktree preparation: ${safe === "hook_execution_approval_required" || safe === "checkout_filter_execution_approval_required" ? "Approve setup in the inbox, then retry worktree setup." : safe === "worktree_single_git_root_required" ? "Choose one Git code folder for this project, then retry setup." : safe === "invalid_ref" ? "Choose an existing base ref, then retry setup." : safe === "submodules_unsupported" || safe === "nested_repositories_unsupported" ? "This repository structure is not supported yet. Choose a repository without nested repositories or submodules." : safe === "workspace_setup_failed" || safe === "workspace_setup_uncertain" ? "Setup did not finish successfully. Inspect the preserved worktree and correct its setup before continuing." : "Check the repository and setup, then retry."} Your brief and existing work are saved.`,
        { commandId, at: new Date().toISOString(), actor: { kind: "system", id: "worktrees" } },
      ),
    );
    options.publish(store.eventsSince(before));
    return parse(TaskSchema, store.record("task", task.id));
  }
}
