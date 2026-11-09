import type { DomainState } from "@zoltbot/core";
import type { Routine } from "@zoltbot/protocol";

/** Only a whole, fresh human message can authorize one exact reviewed revision. */
export function routineHumanAuthorization(
  state: DomainState,
  threadId: string,
  messageId: string,
  routine: Routine,
  method: string,
  occurrenceId?: string,
) {
  const messages = (state.item ?? [])
    .filter((row) => row.threadId === threadId && row.kind === "user")
    .sort((a, b) => Number(b.seq) - Number(a.seq));
  const message = messages[0];
  const body = message?.body as
    | {
        queueVersion?: number;
        origin?: string;
        sourceMessageId?: string;
        sourceInteractionId?: string;
        input?: { type: string; text?: string }[];
      }
    | undefined;
  const verb = (
    {
      "routine.commit": "save",
      "routine.enable": "enable",
      "routine.runOnce": "run once",
    } as Record<string, string>
  )[method];
  const text =
    body?.input?.length === 1 && body.input[0]?.type === "text"
      ? body.input[0].text?.trim()
      : undefined;
  const expected = `${verb} routine ${routine.id} revision ${routine.event?.revision}${method === "routine.runOnce" ? ` event ${occurrenceId}` : ""}`;
  if (
    !verb ||
    message?.id !== messageId ||
    body?.queueVersion !== 1 ||
    body.origin === "agent" ||
    body.sourceMessageId ||
    body.sourceInteractionId ||
    String(message.createdAt) < routine.updatedAt ||
    text?.toLowerCase() !== expected.toLowerCase()
  )
    throw new Error("explicit_human_routine_instruction_required");
  const key = `routine.authorization.${messageId}`;
  if (state.settings?.some((row) => row.key === key))
    throw new Error("human_routine_instruction_already_used");
  return {
    key,
    value: {
      messageId,
      threadId,
      routineId: routine.id,
      revision: routine.event!.revision,
      method,
    },
  };
}
