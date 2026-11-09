import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";
import { observeRuntimeEvent, type RuntimeEventInput } from "./runtime-events.js";
/** Reserve identity and order only. Raw deltas never enter the durable display cache. */
export function reserveRuntimeItem(
  state: DomainState,
  input: RuntimeEventInput,
  context: CommandContext,
): Outcome {
  const event = parse(AgentEventSchema, input.event);
  if (event.t !== "text.delta" && event.t !== "thought.delta")
    throw new Error("runtime_stream_event_required");
  const checked = observeRuntimeEvent(state, { ...input, event }, context);
  if (!checked.result.transient) return checked;
  if (!input.itemId) throw new Error("runtime_item_id_required");
  const kind = event.t === "text.delta" ? "message" : "thought";
  const previous = state.item?.find((row) => row.id === input.itemId);
  if (previous) {
    const body = previous.body as Record<string, unknown> | undefined;
    if (
      previous.threadId !== input.threadId ||
      previous.turnId !== event.turnId ||
      previous.kind !== kind ||
      body?.nativeItemId !== event.itemId
    )
      throw new Error("runtime_item_conflict");
    return {
      events: [],
      result: body.streaming === true ? { transient: true, item: previous } : { ignored: true },
    };
  }
  const created = handle(
    state,
    {
      type: "create",
      kind: "item",
      value: {
        id: input.itemId,
        threadId: input.threadId,
        turnId: event.turnId,
        kind,
        seq:
          (state.item ?? []).reduce(
            (n, row) => (row.threadId === input.threadId ? Math.max(n, Number(row.seq)) : n),
            0,
          ) + 1,
        body: { text: "", streaming: true, nativeItemId: event.itemId },
        createdAt: context.at,
        updatedAt: context.at,
      },
    },
    context,
  );
  return { events: created.events, result: { transient: true, item: created.result } };
}
