import { entitySchemas, parse, parseEvent } from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import { queueHumanInput } from "./input-queue.js";
import type { DomainState } from "./projectors.js";

export type LateAnswerInput = {
  id: string;
  version: number;
  text: string;
  confirmed: boolean;
};
/** Queue a new human message. Never send a response to an expired native request. */
export function forwardLateAnswer(
  state: DomainState,
  input: LateAnswerInput,
  itemId: string,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human" || input.confirmed !== true)
    throw new Error("human_confirmation_required");
  const request = state.interaction?.find((row) => row.id === input.id);
  if (!request) throw new Error("interaction_not_found");
  if (request.version !== input.version) throw new Error("interaction_conflict");
  if (request.state !== "expired") throw new Error("interaction_not_expired");
  const fields = request.items as { secret?: boolean }[];
  if (fields.some((field) => field.secret)) throw new Error("secret_late_forward_forbidden");
  if (typeof input.text !== "string" || !input.text.trim()) throw new Error("empty_message");
  const thread = state.thread?.find((row) => row.id === request.threadId);
  if (!thread || thread.archived || thread.agentId !== request.agentId)
    throw new Error("thread_unavailable");
  if (state.item?.some((row) => row.id === itemId)) throw new Error("item_already_exists");
  const queued = queueHumanInput(
    state,
    {
      threadId: String(request.threadId),
      input: [{ type: "text", text: input.text }],
      mode: "queue",
      sourceInteractionId: input.id,
    },
    itemId,
    context,
  );
  const audit = parse(entitySchemas.audit, {
    id: `audit:${context.commandId}`,
    actor: context.actor,
    action: "interaction.forwardLate",
    target: request.id,
    result: "allowed",
    detail: { confirmed: true, messageId: itemId },
    at: context.at,
  });
  const auditEvent = parseEvent({
    eventId: `${context.commandId}:${queued.events.length}`,
    commandId: context.commandId,
    aggregateType: "audit",
    aggregateId: audit.id,
    type: "audit.created",
    occurredAt: context.at,
    payload: audit,
  });
  return { events: [...queued.events, auditEvent], result: queued.result };
}
