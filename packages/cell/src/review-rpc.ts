import { handle } from "@zoltbot/core";
import type { CommandActor, Task } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store/portable";
import { CellCommands } from "./commands.js";

/** Review commands stay revision-bound; native Git state and private file bytes never enter a Cell. */
export class CellReviews {
  private readonly commands: CellCommands;
  constructor(
    private readonly store: Store,
    private readonly actor: CommandActor,
  ) {
    this.commands = new CellCommands(store);
  }
  preview(task: Task, commandId: string) {
    if (task.createdBy.id !== this.actor.userId) throw new Error("forbidden");
    const id = `review-preview:${commandId}`,
      saved = this.commands.reviewPreview(task.id, id);
    if (saved?.state === "complete") {
      if (saved.result.revision !== task.revision) throw new Error("stale_revision");
      return saved.result;
    }
    if (saved?.state === "failed") throw new Error("runner_unavailable");
    if (task.state !== "review") throw new Error("task_review_required");
    this.commands.enqueue(task.id, id, { type: "review_preview", revision: task.revision });
    return { state: "pending" };
  }
  commit(
    task: Task,
    input: {
      commandId: string;
      requestFingerprint: string;
      fingerprint: string;
      confirmed: boolean;
      message?: string;
    },
  ) {
    if (task.createdBy.id !== this.actor.userId) throw new Error("forbidden");
    if (!input.confirmed) throw new Error("confirmation_required");
    if (input.message?.trim()) throw new Error("cloud_commit_message_unavailable");
    if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) throw new Error("review_preview_stale");
    const id = `review-commit:${input.commandId}`,
      receiptId = `client:${input.commandId}`;
    const receipt = this.store.receipt<{ fingerprint: string; value: Record<string, unknown> }>(
      receiptId,
    );
    if (receipt && receipt.result.fingerprint !== input.requestFingerprint)
      throw new Error("command_conflict");
    const saved = this.commands.reviewCommitted(task.id, id);
    if (saved?.state === "complete") {
      if (saved.result.revision !== task.revision) throw new Error("stale_revision");
      if (saved.result.fingerprint !== input.fingerprint) throw new Error("command_conflict");
      return saved.result;
    }
    if (saved?.state === "failed") throw new Error("runner_unavailable");
    if (receipt) {
      if (!saved) throw new Error("runner_unavailable");
      return { state: "pending" };
    }
    if (task.state !== "review") throw new Error("task_review_required");
    const previews = this.store.database
      .prepare(
        "SELECT command_id FROM cell_runner_review_previews WHERE task_id=? AND revision=? ORDER BY rowid DESC LIMIT 4",
      )
      .all(task.id, task.revision) as { command_id: string }[];
    const previous = previews
      .map((row) => this.commands.reviewPreview(task.id, row.command_id))
      .find((row) => row?.state === "complete" && row.result.fingerprint === input.fingerprint);
    if (previous?.state !== "complete") throw new Error("review_preview_stale");
    if (!previous.result.files.length) throw new Error("no_review_changes");
    if (previous.result.files.some((file) => file.excluded))
      throw new Error("review_files_excluded");
    const context = {
      commandId: receiptId,
      at: new Date().toISOString(),
      actor: { kind: "human" as const, id: this.actor.userId },
    };
    return this.store.dispatch(
      receiptId,
      (state) => {
        this.commands.enqueue(task.id, id, {
          type: "review_commit",
          revision: task.revision,
          fingerprint: input.fingerprint,
          head: previous.result.head,
          base: previous.result.base,
        });
        const audit = handle(
          state,
          {
            type: "create",
            kind: "audit",
            value: {
              id: `audit:${receiptId}`,
              actor: context.actor,
              action: "task.review_commit",
              target: task.id,
              result: "allowed",
              detail: {
                confirmed: true,
                deviceId: this.actor.deviceId,
                surface: this.actor.surface,
                revision: task.revision,
                fingerprint: input.fingerprint,
                head: previous.result.head,
              },
              at: context.at,
            },
          },
          context,
        );
        return {
          events: audit.events,
          result: {
            fingerprint: input.requestFingerprint,
            value: { state: "pending" },
            actor: this.actor,
          },
        };
      },
      { scope: { taskId: task.id }, kinds: ["task", "audit"] },
    ).result.value;
  }
}
