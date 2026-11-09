import { randomUUID } from "node:crypto";
import {
  type DomainEvent,
  type EntityKind,
  parse,
  parseEvent,
  ShippingSchema,
  TaskSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { GitHubClient } from "../../../github/src/client.js";
import type { PublicWriteCheck } from "../private-input.js";
import type { worktreeService } from "../worktree-service.js";

export interface ShippingContext {
  store: Store;
  closed?(): boolean;
  client: GitHubClient;
  publishing?: {
    remoteHead: typeof import("../../../gitkit/src/publish.js").remoteHead;
    publishCommit: typeof import("../../../gitkit/src/publish.js").publishCommit;
  };
  worktrees: ReturnType<typeof worktreeService>;
  publish(events: DomainEvent[]): void;
  checkPublic(value: unknown): Promise<PublicWriteCheck>;
  wake(): Promise<void>;
}
export const now = () => new Date().toISOString();
export const human = (id: string) => ({
  commandId: id,
  at: now(),
  actor: { kind: "human" as const, id: "local-owner" },
});
export function shippingState(context: ShippingContext) {
  const { store } = context;
  return {
    task(id: string) {
      return parse(TaskSchema, store.record("task", id));
    },
    binding(id: string) {
      const row = store.record("shipping", id);
      return row ? parse(ShippingSchema, row) : undefined;
    },
    async workspace(id: string) {
      const task = this.task(id);
      if (!task.workspaceId) throw new Error("shipping_worktree_required");
      return context.worktrees.manager.verify(
        await context.worktrees.manager.load(task.workspaceId),
      );
    },
    async save(kind: EntityKind, value: Record<string, unknown>, commandId: string = randomUUID()) {
      if (context.closed?.()) throw new Error("github_service_closed");
      const check = await context.checkPublic(value);
      const before = store.lastSeq();
      const receipt = store.dispatch(commandId, (state) => {
        if (context.closed?.()) throw new Error("github_service_closed");
        check(state);
        const event = parseEvent({
          eventId: `${commandId}:0`,
          aggregateType: kind,
          aggregateId: String(value.id),
          type: `${kind}.updated`,
          occurredAt: now(),
          payload: value,
        });
        return { events: [event], result: value };
      });
      context.publish(store.eventsSince(before));
      return receipt.result;
    },
    async refresh(id: string) {
      const binding = this.binding(id);
      if (!binding?.snapshot) throw new Error("shipping_pr_required");
      try {
        if ((await context.client.account()) !== binding.account)
          throw new Error("github_account_changed");
        const snapshot = await context.client.pull(binding.repository, binding.snapshot.number);
        if (
          snapshot.repositoryId !== binding.repositoryId ||
          snapshot.nodeId !== binding.snapshot.nodeId
        )
          throw new Error("github_identity_changed");
        if (snapshot.headBranch !== binding.branch || snapshot.baseBranch !== binding.baseBranch)
          throw new Error("shipping_binding_changed");
        await this.save("shipping", { ...binding, snapshot, error: "", updatedAt: now() });
        return snapshot;
      } catch (error) {
        const message =
          error instanceof Error && /^[a-z_]+$/.test(error.message)
            ? error.message
            : "github_request_failed";
        await this.save("shipping", { ...binding, error: message, updatedAt: now() });
        throw new Error(message);
      }
    },
  };
}
