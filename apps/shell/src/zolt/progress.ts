// C10: the agent's progress notes, placed in its chat at the time it posted them. They carry no
// turn id, so turn-based views (branches, thinking blocks) keep treating the reply as the turn's end.
import { chatProgressKey, readProgressNotes } from "@zoltbot/protocol";
import type { ConversationMessage } from "../shared/ipc";
import type { Snapshot } from "./daemon-client";

/** The chat's messages with its progress notes merged in by time. */
export function withProgress(
  snapshot: Snapshot,
  threadId: string,
  messages: ConversationMessage[],
): ConversationMessage[] {
  const row = (snapshot.entities.settings ?? []).find(
    (setting) => setting.key === chatProgressKey(threadId),
  );
  const notes = readProgressNotes(row?.value);
  if (!notes.length) return messages;
  const result = [...messages];
  for (const note of notes) {
    let index = result.length;
    while (index > 0 && (result[index - 1]?.createdAt ?? "") > note.at) index--;
    result.splice(index, 0, {
      id: `progress:${note.id}`,
      author: "assistant",
      source: "assistant",
      text: note.text,
      createdAt: note.at,
      status: "completed",
      progress: true,
    });
  }
  return result;
}
