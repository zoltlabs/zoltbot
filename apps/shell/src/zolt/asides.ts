// C2: side questions shown inside the chat they were asked in. Each aside is a hidden thread
// (kind "aside") copied from this chat; its question and answer appear where it was asked.
import type { ConversationMessage } from "../shared/ipc";
import type { Snapshot } from "./daemon-client";
import { threadItems, userText } from "./mapping";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The chat an aside was asked in, so a change in the aside refreshes that chat. */
export function asideSource(snapshot: Snapshot, threadId: string): string | undefined {
  const thread = snapshot.entities.thread?.find((row) => row.id === threadId);
  if (thread?.kind !== "aside") return undefined;
  return text((thread.fork as Row | undefined)?.sourceThreadId) || undefined;
}

export function asideMessages(snapshot: Snapshot, threadId: string): ConversationMessage[] {
  const asides = (snapshot.entities.thread ?? [])
    .filter(
      (thread) =>
        thread.kind === "aside" &&
        thread.archived !== true &&
        text((thread.fork as Row | undefined)?.sourceThreadId) === threadId,
    )
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)));
  const out: ConversationMessage[] = [];
  for (const aside of asides) {
    const id = text(aside.id);
    const link = { threadId: id };
    const turns = new Map(
      (snapshot.entities.turn ?? [])
        .filter((turn) => turn.threadId === id)
        .map((turn) => [text(turn.id), text(turn.status)]),
    );
    let answered = false;
    let failed = false;
    for (const item of threadItems(snapshot, id)) {
      const body = (item.body ?? {}) as Row;
      if (item.kind === "user") {
        const words = userText(item);
        failed ||= body.queueState === "failed";
        if (words.trim())
          out.push({
            id: text(item.id),
            author: "user",
            source: "user",
            text: words,
            createdAt: text(item.createdAt) || text(aside.createdAt),
            status: "completed",
            aside: link,
          });
        continue;
      }
      if (item.kind !== "message") continue;
      const status = turns.get(text(item.turnId));
      const streaming = body.streaming === true && status === "running";
      if (!text(body.text) && !streaming) continue;
      answered = true;
      out.push({
        id: text(item.id),
        author: "assistant",
        source: "assistant",
        text: text(body.text),
        createdAt: text(item.createdAt),
        status: streaming ? "streaming" : status === "failed" ? "failed" : "completed",
        aside: link,
      });
    }
    const ended = [...turns.values()].some((status) => status !== "running");
    if (failed && !answered)
      out.push({
        id: `${id}:failed`,
        author: "assistant",
        source: "assistant",
        text: "",
        createdAt: text(aside.createdAt),
        status: "failed",
        aside: link,
      });
    // Until the answer starts, a placeholder shows the aside is being worked on.
    else if (!answered && !ended)
      out.push({
        id: `${id}:pending`,
        author: "assistant",
        source: "assistant",
        text: "",
        createdAt: text(aside.createdAt),
        status: "streaming",
        aside: link,
      });
  }
  return out;
}

/** Puts each aside's messages after the chat message that came just before it was asked. */
export function withAsides(
  snapshot: Snapshot,
  threadId: string,
  messages: ConversationMessage[],
): ConversationMessage[] {
  const extra = asideMessages(snapshot, threadId);
  if (!extra.length) return messages;
  const groups = new Map<string, ConversationMessage[]>();
  for (const message of extra) {
    const key = message.aside?.threadId ?? "";
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  const result = [...messages];
  for (const group of groups.values()) {
    const at = group[0]?.createdAt ?? "";
    let index = result.length;
    while (index > 0 && (result[index - 1]?.createdAt ?? "") > at) index--;
    result.splice(index, 0, ...group);
  }
  return result;
}
