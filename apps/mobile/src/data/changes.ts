import { body, text } from "@zoltbot/ui/chat/types";
import { diffTotals } from "./interactions.js";
import type { Row, Snapshot } from "./transport.js";

// What a chat changed on disk, turn by turn, from the diffs its tool items carry (I4).

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}
export interface TurnChanges {
  turnId: string;
  /** The message that started the turn, so the person knows which request did this. */
  prompt: string;
  at: string;
  files: FileChange[];
}

/** Turns that changed files, newest first; a file edited twice in a turn is counted once. */
export function threadChanges(snapshot: Snapshot, threadId: string): TurnChanges[] {
  const items = (snapshot.entities.item ?? [])
    .filter((item) => item.threadId === threadId)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const turns = new Map<string, TurnChanges & { byPath: Map<string, FileChange> }>();
  for (const item of items) {
    const turnId = text(item.turnId);
    if (!turnId) continue;
    const value = body(item);
    if (item.kind === "user" && !turns.has(turnId)) {
      const parts = Array.isArray(value.input) ? (value.input as Row[]) : [];
      turns.set(turnId, {
        turnId,
        prompt: parts
          .filter((part) => part.type === "text")
          .map((part) => text(part.text))
          .join(" ")
          .trim(),
        at: text(item.createdAt),
        files: [],
        byPath: new Map(),
      });
    }
    if (item.kind !== "tool" || !Array.isArray(value.diffs)) continue;
    const turn =
      turns.get(turnId) ??
      turns
        .set(turnId, {
          turnId,
          prompt: "",
          at: text(item.createdAt),
          files: [],
          byPath: new Map(),
        })
        .get(turnId);
    if (!turn) continue;
    for (const diff of value.diffs as Row[]) {
      const path = text(diff.path);
      if (!path) continue;
      const { added, removed } = diffTotals([diff]);
      const file = turn.byPath.get(path);
      if (file) {
        file.added += added;
        file.removed += removed;
      } else {
        const next = { path, added, removed };
        turn.byPath.set(path, next);
        turn.files.push(next);
      }
    }
  }
  return [...turns.values()]
    .filter((turn) => turn.files.length)
    .map(({ byPath: _, ...turn }) => turn)
    .reverse();
}
