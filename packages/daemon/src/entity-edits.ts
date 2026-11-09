import type { DomainState } from "@zoltbot/core";
import { handle } from "@zoltbot/core/commands";
import type { DomainEvent, UserInput } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { PrivateInputGuard } from "./private-input.js";

// What a profile editor may change. Permissions and tools keep their own confirmed flows.
const profileFields = ["name", "definitionId", "model", "instructions"] as const;

/** `agent.update` for the profile editor and `project.archive`, both used by the phone. */
export function entityEditsApi(host: {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
}) {
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (method !== "agent.update" && method !== "project.archive") return undefined;
    if (!commandId) throw new Error("command_id_required");
    if (typeof params.id !== "string") throw new Error("invalid_params");
    const id = params.id;
    let kind: "agent" | "project";
    let changes: Record<string, unknown>;
    if (method === "project.archive") {
      if (params.confirmed !== true) throw new Error("confirmation_required");
      kind = "project";
      changes = { archived: true };
    } else {
      kind = "agent";
      changes = (params.changes ?? {}) as Record<string, unknown>;
      if (typeof changes !== "object" || Object.keys(changes).length === 0)
        throw new Error("invalid_params");
      if (Object.keys(changes).some((key) => !(profileFields as readonly string[]).includes(key)))
        throw new Error("field_not_editable");
      const parts: UserInput = Object.values(changes)
        .filter((value): value is string => typeof value === "string")
        .map((text) => ({ type: "text", text }));
      const check = await host.privacy.prepareInput(parts);
      const before = host.store.lastSeq();
      const receipt = host.store.dispatch(commandId, (state) => {
        check(state);
        const row = state.agent?.find((entry) => entry.id === id);
        if (!row || row.archived) throw new Error("scope_unavailable");
        return update(state, kind, id, changes, commandId);
      });
      host.publish(host.store.eventsSince(before));
      return receipt.result;
    }
    const before = host.store.lastSeq();
    host.store.dispatch(commandId, (state) => {
      const row = state.project?.find((entry) => entry.id === id);
      if (!row) throw new Error("scope_unavailable");
      // Archiving twice is a no-op, so a retried tap succeeds.
      if (row.archived) return { events: [], result: { ok: true } };
      const outcome = update(state, kind, id, changes, commandId);
      return { ...outcome, result: { ok: true } };
    });
    host.publish(host.store.eventsSince(before));
    return { ok: true };
  };
}

function update(
  state: DomainState,
  kind: "agent" | "project",
  id: string,
  changes: Record<string, unknown>,
  commandId: string,
) {
  return handle(
    state,
    { type: "update", kind, id, changes, confirmed: true },
    { commandId, at: new Date().toISOString(), actor: { kind: "human", id: "local-owner" } },
  );
}
