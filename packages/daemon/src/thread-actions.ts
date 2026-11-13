import { activeWake, applyEvents, cancelWake, type DomainState, handle } from "@zoltbot/core";
import { type DomainEvent, parseEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateInputGuard } from "./private-input.js";

const methods = new Set(["thread.rename", "thread.pin", "thread.archive", "thread.delete"]);
const owner = { kind: "human", id: "local-owner" } as const;
const noItems = { items: { ids: [] } };

function refusedThreadKind(state: DomainState, id: string, row: Record<string, unknown>) {
  return (
    row.kind === "task" ||
    Boolean(row.taskId) ||
    Boolean(state.compareMember?.some((member) => member.threadId === id))
  );
}

/** Chat management actions: rename, pin, confirmed archive, and confirmed deletion. */
export function threadActionsApi(host: {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
  stopThread(threadId: string, forceCleanup?: boolean): Promise<void> | undefined;
  clearInteractions(threadId: string, commandId: string): Promise<unknown> | undefined;
}) {
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (!methods.has(method)) return undefined;
    if (!commandId) throw new Error("command_id_required");
    if (typeof params.id !== "string") throw new Error("invalid_params");
    const id = params.id;

    if (method === "thread.rename") {
      const title = String(params.title ?? "").trim();
      if (!title) throw new Error("invalid_params: title required");
      const check = await host.privacy.prepareInput([{ type: "text", text: title }]);
      const before = host.store.lastSeq();
      const receipt = host.store.dispatch(
        commandId,
        (state) => {
          check(state);
          const row = state.thread?.find((entry) => entry.id === id);
          if (!row) throw new Error("not_found: thread");
          return handle(
            state,
            { type: "update", kind: "thread", id, changes: { title, titleSource: "human" } },
            { commandId, at: new Date().toISOString(), actor: owner },
          );
        },
        noItems,
      );
      host.publish(host.store.eventsSince(before));
      return receipt.result;
    }

    if (method === "thread.pin") {
      const before = host.store.lastSeq();
      const receipt = host.store.dispatch(
        commandId,
        (state) => {
          const row = state.thread?.find((entry) => entry.id === id);
          if (!row) throw new Error("not_found: thread");
          return handle(
            state,
            { type: "update", kind: "thread", id, changes: { pinned: Boolean(params.pinned) } },
            { commandId, at: new Date().toISOString(), actor: owner },
          );
        },
        noItems,
      );
      host.publish(host.store.eventsSince(before));
      return receipt.result;
    }

    if (method === "thread.archive") {
      if (params.confirmed !== true) throw new Error("confirmation_required");
      const archiveCommandId = `${commandId}:archive`;
      if (host.store.receipt(archiveCommandId)) return { ok: true };
      const snapshot = host.store.snapshot(["thread", "compareMember"]);
      const row = snapshot.thread?.find((entry) => entry.id === id);
      if (!row) throw new Error("not_found: thread");
      if (refusedThreadKind(snapshot, id, row))
        throw new Error("invalid_state: task and compare threads cannot be archived as chats");
      await host.stopThread(id, false);
      await host.clearInteractions(id, `${commandId}:clear`);
      const before = host.store.lastSeq();
      host.store.dispatch(
        archiveCommandId,
        (state) => {
          const current = state.thread?.find((entry) => entry.id === id);
          if (!current) throw new Error("not_found: thread");
          if (refusedThreadKind(state, id, current))
            throw new Error("invalid_state: task and compare threads cannot be archived as chats");
          if (current.archived && !current.archiveWhenIdle && !current.wakePending)
            return { events: [], result: { ok: true } };
          const at = new Date().toISOString();
          const events: DomainEvent[] = [];
          let intermediate = state;
          for (const wake of state.wake ?? []) {
            if (wake.threadId !== id || (!activeWake(wake) && wake.status !== "draft")) continue;
            const canceled = cancelWake(intermediate, String(wake.id), Number(wake.revision), {
              commandId: `${archiveCommandId}:wake:${String(wake.id)}`,
              at,
              actor: owner,
            });
            events.push(...canceled.events);
            intermediate = applyEvents(intermediate, canceled.events);
          }
          const updated = handle(
            intermediate,
            {
              type: "update",
              kind: "thread",
              id,
              changes: {
                archived: true,
                archiveWhenIdle: undefined,
                snoozedUntil: undefined,
                wakePending: undefined,
              },
            },
            { commandId: archiveCommandId, at, actor: owner },
          );
          events.push(...updated.events);
          return { events, result: { ok: true } };
        },
        noItems,
      );
      host.publish(host.store.eventsSince(before));
      return { ok: true };
    }

    if (params.confirmed !== true) throw new Error("confirmation_required");
    if (host.store.receipt(commandId)) return { ok: true };
    const snapshot = host.store.snapshot(["thread", "compareMember"]);
    const row = snapshot.thread?.find((entry) => entry.id === id);
    if (!row) throw new Error("not_found: thread");
    if (refusedThreadKind(snapshot, id, row))
      throw new Error("invalid_state: task and compare threads cannot be deleted as chats");
    await host.stopThread(id, true);
    const before = host.store.lastSeq();
    const receipt = host.store.dispatch(
      commandId,
      (state) => {
        const current = state.thread?.find((entry) => entry.id === id);
        if (!current) return { events: [], result: { ok: true } };
        if (refusedThreadKind(state, id, current))
          throw new Error("invalid_state: task and compare threads cannot be deleted as chats");
        return {
          events: [
            parseEvent({
              eventId: `${commandId}:deleted`,
              commandId,
              aggregateType: "thread",
              aggregateId: id,
              type: "thread.deleted",
              occurredAt: new Date().toISOString(),
              payload: { id },
            }),
          ],
          result: { ok: true },
        };
      },
      noItems,
    );
    const emitted = host.store.eventsSince(before);
    if (receipt.toSeq > before) host.store.purgeDeletedThreadEvents(id, receipt.toSeq);
    host.publish(emitted);
    return { ok: true };
  };
}
