import type { UserInput } from "@zoltbot/protocol";
import type { Snapshot } from "./transport.js";
import { place, profileName, text } from "./view.js";

export interface ShareRecipient {
  id: string;
  macId: string;
  threadId: string;
  name: string;
}
export interface SharedDraft {
  version: 1;
  id: string;
  createdAt: string;
  macId: string;
  recipientId: string;
  text: string;
  images: { base64: string; mimeType: "image/jpeg" }[];
  sentThreadId?: string;
}

/** Publish actual conversations, never generic profiles or temporary task/side threads. */
export function shareRecipients(snapshot: Snapshot, macId: string): ShareRecipient[] {
  if (!macId) return [];
  const active = (kind: string, id: unknown) =>
    (snapshot.entities[kind] ?? []).some(
      (row) => row.id === id && row.archived !== true && row.hidden !== true,
    );
  return (snapshot.entities.thread ?? [])
    .filter((thread) => {
      const node = thread.node as { type?: string; id?: string } | undefined;
      return (
        thread.archived !== true &&
        (thread.kind === "main" || thread.kind === "manager") &&
        active("agent", thread.agentId) &&
        (!thread.projectId || active("project", thread.projectId)) &&
        (node?.type !== "subproject" || active("subproject", node.id))
      );
    })
    .sort((a, b) => {
      const rank = Number(b.kind === "main") - Number(a.kind === "main");
      return rank || text(a.id).localeCompare(text(b.id));
    })
    .map((thread) => ({
      id: JSON.stringify([macId, text(thread.id)]),
      macId,
      threadId: text(thread.id),
      name: [profileName(snapshot, thread.agentId), place(snapshot, thread)]
        .filter(Boolean)
        .join(" · "),
    }));
}

export function draftDestination(
  draft: SharedDraft,
  recipients: ShareRecipient[],
  recipientId = draft.recipientId,
) {
  return recipients.find((row) => row.id === recipientId && row.macId === draft.macId);
}

export function sharedDraftInput(draft: SharedDraft, message = draft.text): UserInput {
  if (new TextEncoder().encode(message).length > 16_000)
    throw new Error("Keep the message under 16,000 bytes.");
  if (draft.images.length > 5 || draft.images.some((image) => image.base64.length > 80_000))
    throw new Error("The shared photos exceed the message size limit.");
  const input: UserInput = [
    ...(message.trim() ? [{ type: "text" as const, text: message.trim() }] : []),
    ...draft.images.map((image) => ({ type: "image" as const, ...image })),
  ];
  if (!input.length) throw new Error("Add a message or photo before sending.");
  return input;
}
