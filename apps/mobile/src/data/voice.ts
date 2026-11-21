// O4 and O5: what voice on the phone reads from a chat. Finished calls show as "Call · 2:15", as
// on the Mac, and a call reads each reply that finishes after it starts.
import { callDuration, chatCallsKey, readCalls } from "@zoltbot/protocol";
import type { TranscriptRow } from "./timeline";
import type { Snapshot } from "./transport";

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The chat's rows with each finished call placed where it ended. */
export function withCalls(
  snapshot: Snapshot,
  threadId: string,
  rows: TranscriptRow[],
): TranscriptRow[] {
  const calls = readCalls(
    (snapshot.entities.settings ?? []).find((row) => row.key === chatCallsKey(threadId))?.value,
  );
  if (!calls.length) return rows;
  const at = new Map(
    (snapshot.entities.item ?? [])
      .filter((item) => item.threadId === threadId)
      .map((item) => [text(item.id), text(item.createdAt)]),
  );
  const result = [...rows];
  for (const call of calls) {
    let index = result.length;
    // Rows without a time of their own (notes, cards) stay where they are.
    while (index > 0 && (at.get(result[index - 1]?.id ?? "") ?? "") > call.endedAt) index--;
    result.splice(index, 0, {
      id: `call:${call.id}`,
      kind: "other",
      text: "",
      streaming: false,
      notice: {
        kind: "call",
        text: "Call",
        meta: callDuration(Date.parse(call.endedAt) - Date.parse(call.startedAt)),
      },
    });
  }
  return result;
}

/** A finished reply from the agent with words to read: not a note, a card or a side question. */
export const readableReply = (row: TranscriptRow) =>
  row.kind === "message" &&
  !row.streaming &&
  !row.progress &&
  !row.hidden &&
  !row.aside &&
  !row.notice &&
  !row.manager &&
  !row.event &&
  Boolean(row.text.trim());

/**
 * Replies to read on a call: ones not there when it started (`seen`), in order. Each is returned
 * once; `seen` keeps them after.
 */
export function newReplies(rows: TranscriptRow[], seen: Set<string>): TranscriptRow[] {
  const fresh: TranscriptRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    // A reply still streaming is read once it finishes; anything else is never read later.
    if (row.kind === "message" && row.streaming) continue;
    seen.add(row.id);
    if (readableReply(row)) fresh.push(row);
  }
  return fresh;
}
