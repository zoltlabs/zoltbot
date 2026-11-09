import { createHash } from "node:crypto";
import { handle } from "@zoltbot/core";
import {
  type DomainEvent,
  HOST_WORKSPACE_REF,
  type InteractionDraft,
  parse,
  TaskSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import {
  clean,
  commit,
  createReviewCommit,
  git,
  integrate,
  previewIntegration,
  previewReview,
} from "../../gitkit/src/index.js";
import { cleanupRepositoryRoot } from "./artifacts/repository-files.js";
import { cleanupThreadStaging } from "./artifacts/staging.js";
import type { worktreeService } from "./worktree-service.js";

export function worktreeApi(options: {
  store: Store;
  worktrees: ReturnType<typeof worktreeService>;
  publish(events: DomainEvent[]): void;
  requestApproval?(draft: InteractionDraft, commandId: string): Promise<unknown>;
}) {
  const { store, worktrees } = options;
  const save = (commandId: string, key: string, value: Record<string, unknown>) => {
    const before = store.lastSeq();
    const result = store.dispatch(commandId, (state) => {
      const existing = state.settings?.find((row) => row.key === key);
      const output = handle(
        state,
        existing
          ? { type: "update", kind: "settings", id: key, changes: { value } }
          : {
              type: "create",
              kind: "settings",
              value: { key, value },
            },
        { commandId, at: new Date().toISOString(), actor: { kind: "human", id: "local-owner" } },
      );
      if (
        key.startsWith("worktree.review.") &&
        store.database
          .prepare("SELECT 1 FROM sqlite_master WHERE name='worktree_review_evidence'")
          .get()
      ) {
        store.database
          .prepare(
            "INSERT OR IGNORE INTO worktree_review_evidence(task_id,task_revision,source_commit,base_commit,body,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            key.slice("worktree.review.".length),
            value.revision,
            value.head,
            value.base,
            JSON.stringify(value),
            new Date().toISOString(),
          );
      }
      return { events: output.events, result: value };
    });
    options.publish(store.eventsSince(before));
    return result.result;
  };
  const saved = (key: string) =>
    store.snapshot(["settings"]).settings?.find((row) => row.key === key)?.value as
      | Record<string, unknown>
      | undefined;
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (
      ![
        "task.reviewCommitPreview",
        "task.reviewCommit",
        "task.integrationPreview",
        "task.integrate",
        "task.archiveWorkspace",
        "task.restoreWorkspace",
      ].includes(method)
    )
      return undefined;
    const task = parse(TaskSchema, store.record("task", String(params.id)));
    if (!task.workspaceId || !task.threadId || !task.ownerAgentId)
      throw new Error("worktree_unavailable");
    if (!["review", "completed"].includes(task.state)) throw new Error("task_review_required");
    if (method === "task.restoreWorkspace") {
      if (!commandId || params.confirmed !== true) throw new Error("confirmation_required");
      const restored = await worktrees.manager.restore(task.workspaceId, true);
      return save(commandId, `worktree.archive.${task.id}`, {
        state: "restored",
        cwd: restored.cwd,
      });
    }
    await cleanupThreadStaging(store, task.threadId);
    const binding = await worktrees.manager.verify(await worktrees.manager.load(task.workspaceId));
    await cleanupRepositoryRoot(binding.cwd);
    if (method === "task.archiveWorkspace") {
      if (!commandId || params.confirmed !== true || task.state !== "completed")
        throw new Error("confirmation_required");
      const active = store
        .snapshot(["session"])
        .session?.some(
          (row) =>
            row.threadId === task.threadId &&
            ["starting", "ready", "running"].includes(String(row.state)),
        );
      if (active) throw new Error("close_session_before_archive");
      if (
        store
          .snapshot(["thread"])
          .thread?.some(
            (r) =>
              (r.fork as { workspaceId?: string } | undefined)?.workspaceId === task.workspaceId,
          )
      )
        throw Error("workspace_retained_by_fork");
      const archived = await worktrees.manager.archive(task.workspaceId, true);
      return save(commandId, `worktree.archive.${task.id}`, {
        state: "archived",
        snapshot: archived.archive,
      });
    }
    if (method === "task.reviewCommitPreview")
      return previewReview(binding.cwd, binding.baseCommit);
    if (method === "task.integrationPreview") {
      if (task.state !== "completed") throw new Error("accept_result_first");
      const review = saved(`worktree.review.${task.id}`);
      if (!review || review.revision !== task.revision) throw new Error("review_commit_required");
      return previewIntegration(binding.cwd, binding.repository, String(review.head));
    }
    if (!commandId || params.confirmed !== true) throw new Error("confirmation_required");
    if (store.receipt(commandId)) return store.receipt(commandId)?.result;
    if (method === "task.reviewCommit") {
      const preview = await previewReview(binding.cwd, binding.baseCommit);
      if (preview.fingerprint !== params.fingerprint) throw new Error("review_preview_stale");
      const message = typeof params.message === "string" ? params.message : `Review: ${task.title}`;
      const approvalId = `worktree-commit-${createHash("sha256").update(`${task.id}:${task.revision}:${preview.fingerprint}:${message}`).digest("hex")}`;
      const approval = store.record("interaction", approvalId);
      if (!approval) {
        if (!options.requestApproval) throw new Error("approval_unavailable");
        await options.requestApproval(
          {
            id: approvalId,
            agentId: task.ownerAgentId,
            threadId: task.threadId,
            taskId: task.id,
            type: "approval",
            title: "Create review commit",
            nativeRef: HOST_WORKSPACE_REF,
            urgency: "background",
            chain: [{ kind: "human", id: "local-owner" }],
            context: {
              cwd: binding.cwd,
              command: `git add -- <reviewed paths>; git commit -m ${JSON.stringify(message)}`,
              toolName: "worktree_review_commit",
              toolKind: "execute",
              paths: preview.files.map((file) => file.path),
              markdown:
                "Git may execute configured clean filters, commit hooks and signing programs. Approve this exact content and configuration before continuing.",
              toolInput: {
                worktreeExecution: true,
                fingerprint: preview.fingerprint,
                executionHash: preview.executionHash,
              },
            },
            items: [
              {
                id: "execute",
                prompt:
                  "Allow this Git commit and its configured code execution in the displayed worktree?",
                choices: [{ id: "allow_once" }, { id: "reject_once" }],
              },
            ],
          },
          `request:${approvalId}`,
        );
        return { pendingApproval: approvalId };
      }
      const resolution = approval.resolution as
        | { action?: string; choice?: string; automatic?: boolean }
        | undefined;
      if (
        approval.state !== "answered" ||
        resolution?.action !== "accept" ||
        resolution.choice !== "allow_once" ||
        resolution.automatic
      )
        throw new Error("review_execution_approval_required");
      const previousReview = saved(`worktree.review.${task.id}`);
      const result = await createReviewCommit(preview, message, true, preview.executionHash);
      if (previousReview?.head) {
        result.previous = String(previousReview.head);
        result.incremental = await git(binding.cwd, [
          "diff",
          "--stat",
          result.previous,
          result.head,
          "--",
        ]);
      }
      save(commandId, `worktree.review.${task.id}`, { ...result, revision: task.revision });
      return result;
    }
    if (task.state !== "completed") throw new Error("accept_result_first");
    const review = saved(`worktree.review.${task.id}`);
    if (!review || review.revision !== task.revision) throw new Error("review_commit_required");
    const interrupted = saved(`worktree.integration.${task.id}`);
    if (interrupted?.state === "preparing") {
      const original = interrupted.preview as { sourceCommit: string; destinationHead: string };
      if (original.sourceCommit !== String(review.head))
        throw new Error("integration_recovery_required");
      if ((await commit(binding.repository, "HEAD")) === original.sourceCommit) {
        await clean(binding.repository);
        const backupRef = String(interrupted.backupRef);
        if ((await commit(binding.repository, backupRef)) !== original.destinationHead)
          throw new Error("integration_recovery_required");
        const result = { head: original.sourceCommit, backupRef };
        save(commandId, `worktree.integration.${task.id}`, {
          state: "integrated",
          ...result,
          source: original.sourceCommit,
        });
        return result;
      }
    }
    const preview = await previewIntegration(binding.cwd, binding.repository, String(review.head));
    if (preview.fingerprint !== params.fingerprint) throw new Error("integration_preview_stale");
    const backupRef = `refs/zoltbot/integration-backups/${createHash("sha256").update(commandId).digest("hex")}`;
    save(`intent:${commandId}`, `worktree.integration.${task.id}`, {
      state: "preparing",
      preview,
      backupRef,
    });
    const result = await integrate(preview, true, backupRef);
    save(commandId, `worktree.integration.${task.id}`, {
      state: "integrated",
      ...result,
      source: preview.sourceCommit,
    });
    return result;
  };
}
