import { createHash, randomUUID } from "node:crypto";
import type { Store } from "@zoltbot/store";

/** Metadata and command receipt commit together; retries never widen access twice. */
export function connectionWrite<T>(
  store: Store,
  commandId: string | undefined,
  method: string,
  params: unknown,
  write: (state: ReturnType<Store["snapshot"]>) => T,
): T {
  if (!commandId) throw new Error("command_id_required");
  const identity = createHash("sha256").update(JSON.stringify({ method, params })).digest("hex");
  const receipt = store.dispatch(commandId, (state) => ({
    events: [
      {
        eventId: randomUUID(),
        aggregateType: "settings",
        aggregateId: "connections.revision",
        type: "settings.updated",
        occurredAt: new Date().toISOString(),
        payload: { key: "connections.revision", value: randomUUID() },
      },
    ],
    result: { operation: "connection", identity, value: write(state) },
  }));
  const result = receipt.result;
  if (result.operation !== "connection" || result.identity !== identity)
    throw new Error("command_receipt_conflict");
  return result.value;
}
