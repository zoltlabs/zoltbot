// O2: what a call adds to a chat. Its first message carries a line of guidance for the agent, what
// the owner says steers a running reply, and each finished call shows as "Call · 2:15".
import { callDuration, chatCallsKey, readCalls, VOICE_CALL_GUIDANCE } from "@zoltbot/protocol";
import type { ConversationMessage, SendMessageInput } from "../shared/ipc";
import type { Snapshot } from "./daemon-client";

type Part = Record<string, unknown>;

export function callParts(call: SendMessageInput["call"], parts: Part[]): Part[] {
  return call?.first ? [{ type: "text", text: VOICE_CALL_GUIDANCE }, ...parts] : parts;
}

/** On a call the owner may talk over a reply; the daemon queues it when the agent can't steer. */
export const sendMode = (input: SendMessageInput) => (input.call ? "steer" : "queue");

/** The chat's messages with its finished calls placed where they ended. */
export function withCalls(
  snapshot: Snapshot,
  threadId: string,
  messages: ConversationMessage[],
): ConversationMessage[] {
  const row = (snapshot.entities.settings ?? []).find((s) => s.key === chatCallsKey(threadId));
  const calls = readCalls(row?.value);
  if (!calls.length) return messages;
  const result = [...messages];
  for (const call of calls) {
    let index = result.length;
    while (index > 0 && (result[index - 1]?.createdAt ?? "") > call.endedAt) index--;
    result.splice(index, 0, {
      id: `call:${call.id}`,
      author: "assistant",
      source: "system",
      text: "",
      createdAt: call.endedAt,
      status: "completed",
      notice: {
        kind: "call",
        text: "Call",
        meta: callDuration(Date.parse(call.endedAt) - Date.parse(call.startedAt)),
      },
    });
  }
  return result;
}
