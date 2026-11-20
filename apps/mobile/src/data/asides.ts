// C2: side questions shown inside the chat they were asked in, as on the Mac. Each aside is a
// hidden read-only thread (kind "aside"); its question and answer show where it was asked.
import type { TranscriptRow } from "./timeline";
import type { Row, Snapshot } from "./transport";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const said = (body: Row) =>
  ((body.input ?? []) as { type?: string; text?: string }[])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("");

function rowsOf(snapshot: Snapshot, aside: Row): TranscriptRow[] {
  const id = text(aside.id);
  const turns = new Map(
    (snapshot.entities.turn ?? [])
      .filter((turn) => turn.threadId === id)
      .map((turn) => [text(turn.id), text(turn.status)]),
  );
  const items = (snapshot.entities.item ?? [])
    .filter((item) => item.threadId === id)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const rows: TranscriptRow[] = [];
  let answered = false;
  let failed = false;
  for (const item of items) {
    const body = (item.body ?? {}) as Row;
    if (item.kind === "user") failed ||= body.queueState === "failed";
    if (item.kind === "user" && said(body).trim())
      rows.push({
        id: text(item.id),
        kind: "user",
        text: said(body),
        streaming: false,
        aside: { threadId: id, question: true },
      });
    if (item.kind !== "message") continue;
    const streaming = body.streaming === true && turns.get(text(item.turnId)) === "running";
    if (!text(body.text) && !streaming) continue;
    answered = true;
    rows.push({
      id: text(item.id),
      kind: "message",
      text: text(body.text),
      streaming,
      aside: { threadId: id, question: false },
    });
  }
  const ended = [...turns.values()].some((status) => status !== "running");
  if (!answered && (failed || !ended))
    rows.push({
      id: `${id}:${failed ? "failed" : "pending"}`,
      kind: "message",
      text: "",
      streaming: !failed,
      ...(failed ? { status: "failed" as const } : {}),
      aside: { threadId: id, question: false },
    });
  return rows;
}

/** Adds each aside after the chat row that came just before it was asked. */
export function withAsides(
  snapshot: Snapshot,
  threadId: string,
  rows: TranscriptRow[],
): TranscriptRow[] {
  const asides = (snapshot.entities.thread ?? [])
    .filter(
      (thread) =>
        thread.kind === "aside" &&
        thread.archived !== true &&
        text((thread.fork as Row | undefined)?.sourceThreadId) === threadId,
    )
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)));
  if (!asides.length) return rows;
  const created = new Map(
    (snapshot.entities.item ?? [])
      .filter((item) => item.threadId === threadId)
      .map((item) => [text(item.id), text(item.createdAt)]),
  );
  const result = [...rows];
  for (const aside of asides) {
    const at = text(aside.createdAt);
    let index = result.length;
    while (
      index > 0 &&
      !result[index - 1]?.aside &&
      (created.get(result[index - 1]?.id ?? "") ?? "") > at
    )
      index--;
    result.splice(index, 0, ...rowsOf(snapshot, aside));
  }
  return result;
}
