import type { ConversationRow } from "./activity-data.js";
import { body, type Row, text } from "./types.js";

/** A finished turn's work, folded to one line above its answer. */
export type FoldRow = {
  type: "fold";
  key: string;
  turnId: string;
  label: string;
  expanded: boolean;
};

/** The running turn's shimmering "Working…" line, shown while nothing else shows progress. */
export type WorkingRow = { type: "working"; key: string; turnId: string; startedAt: string };

/** "850ms", "4.2s", "2m 14s", "1h 5s": rounded before the unit is chosen, so never "60s". */
export function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const total = Math.round(ms / 1000),
    hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    seconds = total % 60;
  return [hours && `${hours}h`, minutes && `${minutes}m`, seconds && `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

function rowTurn(row: ConversationRow) {
  if (row.type === "activity") return text(row.items[0]?.turnId);
  if (row.type === "artifact") return row.turnId;
  return text(row.item.turnId);
}

/** Work that folds away: tool runs, reasoning, plan updates and commentary before the answer. */
function foldable(row: ConversationRow) {
  if (row.type === "activity") return true;
  if (row.type !== "message") return false;
  const { kind } = row.item,
    value = body(row.item);
  if (kind === "thought" || kind === "plan" || kind === "message") return true;
  return (
    kind === "tool" &&
    value.interactive !== true &&
    (!["error", "denied"].includes(text(value.status)) || value.recovered === true)
  );
}

/**
 * Folds each finished turn to "Worked for 2m 14s" plus its answer. Questions, approvals, failures,
 * notes and artifacts stay visible. `open` holds the turns the person expanded.
 */
export function foldTurns(
  rows: ConversationRow[],
  turns: Row[],
  open: ReadonlySet<string>,
): (ConversationRow | FoldRow)[] {
  const finished = new Map<string, Row>();
  for (const turn of turns)
    if (["completed", "failed", "interrupted"].includes(text(turn.status)) && text(turn.endedAt))
      finished.set(text(turn.id), turn);
  if (!finished.size) return rows;
  // The answer is the turn's final message, else its last message.
  const answer = new Map<string, string>();
  for (const row of rows) {
    if (row.type !== "message" || row.item.kind !== "message") continue;
    const turnId = text(row.item.turnId);
    if (!finished.has(turnId)) continue;
    const current = answer.get(turnId);
    if (row.item.phase === "final" || !current || !current.startsWith("final:"))
      answer.set(turnId, `${row.item.phase === "final" ? "final:" : ""}${row.key}`);
  }
  const answerKey = (turnId: string) => answer.get(turnId)?.replace(/^final:/, "");
  const hides = (row: ConversationRow, turnId: string) =>
    foldable(row) && row.key !== answerKey(turnId);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const turnId = rowTurn(row);
    if (finished.has(turnId) && hides(row, turnId))
      counts.set(turnId, (counts.get(turnId) ?? 0) + 1);
  }
  const result: (ConversationRow | FoldRow)[] = [],
    placed = new Set<string>();
  for (const row of rows) {
    const turnId = rowTurn(row),
      turn = finished.get(turnId);
    if (!turn || !counts.get(turnId) || !hides(row, turnId)) {
      result.push(row);
      continue;
    }
    const expanded = open.has(turnId);
    if (!placed.has(turnId)) {
      placed.add(turnId);
      const took = formatDuration(
        new Date(text(turn.endedAt)).getTime() - new Date(text(turn.startedAt)).getTime(),
      );
      const label =
        turn.status === "interrupted"
          ? took
            ? `You stopped after ${took}`
            : "You stopped this response"
          : took
            ? `Worked for ${took}`
            : "Worked";
      result.push({ type: "fold", key: `fold:${turnId}`, turnId, label, expanded });
    }
    if (expanded) result.push(row);
  }
  return result;
}

/**
 * Adds a "Working…" line under a running turn until something in it shows progress itself: a
 * step that is running or a reply that is streaming.
 */
export function withWorking<T extends ConversationRow | FoldRow>(
  rows: T[],
  turns: Row[],
): (T | WorkingRow)[] {
  const turn = turns.find((row) => text(row.status) === "running" && !text(row.endedAt));
  if (!turn) return rows;
  const turnId = text(turn.id);
  const live = rows.some((row) => {
    if (row.type === "activity")
      return row.items.some((item) => {
        const value = body(item);
        return item.turnId === turnId && (value.streaming === true || value.status === "running");
      });
    return (
      row.type === "message" && row.item.turnId === turnId && body(row.item).streaming === true
    );
  });
  if (live) return rows;
  return [
    ...rows,
    { type: "working", key: `working:${turnId}`, turnId, startedAt: text(turn.startedAt) },
  ];
}
