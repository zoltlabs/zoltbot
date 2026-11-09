import type { UserInput } from "@zoltbot/protocol";
import { type SharedDraft, type ShareRecipient, sharedDraftInput } from "./sharing.js";

export class SharedDraftSentError extends Error {
  constructor(
    public readonly threadId: string,
    cause: unknown,
  ) {
    super("The message was sent, but its saved draft could not be cleaned up.", { cause });
  }
}

/** Persist before sending; resolve the live destination again after the storage await. */
export async function deliverSharedDraft(
  draft: SharedDraft,
  message: string,
  operations: {
    save(): Promise<void>;
    destination(): ShareRecipient | undefined;
    send(threadId: string, input: UserInput): Promise<unknown>;
    acknowledged(threadId: string): void;
    markSent(threadId: string): Promise<void>;
    remove(): Promise<void>;
  },
): Promise<string> {
  if (draft.sentThreadId) throw new SharedDraftSentError(draft.sentThreadId, "Already sent");
  const input = sharedDraftInput(draft, message);
  await operations.save();
  const destination = operations.destination();
  if (!destination || destination.macId !== draft.macId)
    throw new Error("Reconnect to the original Mac and choose an available bot.");
  await operations.send(destination.threadId, input);
  operations.acknowledged(destination.threadId);
  try {
    await operations.markSent(destination.threadId);
    await operations.remove();
  } catch (cause) {
    throw new SharedDraftSentError(destination.threadId, cause);
  }
  return destination.threadId;
}
