// Vault changes and uses are audited by entry id and action only, never with a value or label.
import { randomUUID } from "node:crypto";
import { handle } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

export interface VaultAuditHost {
  store: Store;
  publish(events: DomainEvent[]): void;
}

export function writeVaultAudit(
  host: VaultAuditHost,
  input: {
    /** A fixed id, when the audit row also records that something was used up. */
    id?: string;
    action: string;
    entryId: string;
    actor: { kind: "human" | "agent"; id: string };
    result?: string;
    detail?: Record<string, string>;
  },
) {
  const commandId = input.id ?? `vault-audit:${randomUUID()}`;
  const at = new Date().toISOString();
  const before = host.store.lastSeq();
  host.store.dispatch(commandId, (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "audit",
        value: {
          id: commandId,
          actor: input.actor,
          action: input.action,
          target: input.entryId,
          result: input.result ?? "ok",
          ...(input.detail ? { detail: input.detail } : {}),
          at,
        },
      },
      { commandId, at, actor: { kind: "system", id: "vault" } },
    ),
  );
  host.publish(host.store.eventsSince(before));
}
