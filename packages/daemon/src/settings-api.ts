import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { reservedChiefKeys } from "./chief/identity.js";
import { identityReferenceKey } from "./link-identity.js";
import type { Redactor } from "./logging.js";
import type { PrivateInputGuard } from "./private-input.js";
import { relayUrlPattern } from "./relay-link.js";

/** Rows only the daemon writes: forks, routine handoffs, private runtime state and the like. */
function reserved(key: string) {
  return (
    key.startsWith("view.") ||
    key.startsWith("fork.") ||
    key.startsWith("routine.handoff.") ||
    key.startsWith("routine.event.health.") ||
    key.startsWith("runtime.private.") ||
    key.startsWith("runtime.privateRef.") ||
    key.startsWith("runtime.configuration.") ||
    key.startsWith("knowledge.exclusions.") ||
    reservedChiefKeys.has(key) ||
    key === identityReferenceKey
  );
}

/** JSON with sorted keys, so equal values compare equal whatever their key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** settings.get and settings.set. Settings are free-form rows keyed by name. */
export function settingsApi(options: {
  store: Store;
  privacy: PrivateInputGuard;
  redactor: Redactor;
  publish(events: DomainEvent[]): void;
}) {
  const { store, redactor } = options;
  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    if (method === "settings.get") return store.snapshot().settings ?? [];
    if (method !== "settings.set") return undefined;
    if (!commandId) throw new Error("command_id_required");
    const input = structuredClone({ key: String(params.key), value: params.value });
    if (reserved(input.key)) throw new Error("setting_reserved");
    if (
      input.key === "link.relayUrl" &&
      !(
        input.value === "" ||
        (typeof input.value === "string" && relayUrlPattern.test(input.value.trim()))
      )
    )
      throw new Error("invalid_relay_url: use a wss:// address");
    const check = store.receipt(commandId)
      ? undefined
      : await options.privacy.prepareData(undefined);
    // Compare-and-set: two devices merging into one row must not overwrite each other.
    const expected = params.expected as { value?: unknown } | undefined;
    const conflict = (rows: Record<string, unknown>[] | undefined) =>
      expected !== undefined &&
      stable(rows?.find((row) => row.key === input.key)?.value) !== stable(expected.value);
    if (redactor.text(commandId) !== commandId) throw new Error("invalid_command_id");
    const value = redactor.value(input);
    const before = store.lastSeq();
    store.dispatch(commandId, (snapshot) => {
      check?.(snapshot);
      if (conflict(snapshot.settings)) throw new Error("setting_conflict");
      return {
        events: [
          {
            eventId: `${commandId}:0`,
            aggregateType: "settings",
            aggregateId: value.key,
            type: "settings.created",
            occurredAt: new Date().toISOString(),
            payload: value,
          },
        ],
        result: { ok: true },
      };
    });
    options.publish(store.eventsSince(before));
    return { ok: true };
  };
}
