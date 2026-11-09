import { body, type Row, text } from "./types.js";

export interface TimelineGroups {
  /** Rows shown directly in the conversation, in order. */
  top: Row[];
  /** Rows produced inside a subagent, keyed by the parent tool item's id. */
  nested: Map<string, Row[]>;
  /** The newest top level plan, shown as the pinned to-do list. */
  latestPlan: Row | undefined;
}

const parentRef = (row: Row) => text(body(row).parentItemId);

/**
 * Groups subagent output under its parent tool item and folds plan updates. A parent can be named
 * by its item id or its native item id. Missing parents and cycles fall back to the top level, so
 * no row is ever hidden. Runs in one pass over the rows plus a bounded walk per nested row.
 */
export function groupTimeline(items: Row[]): TimelineGroups {
  // Parents are tool items only, so only tool rows are indexed; the walk below never leaves them.
  const parents = new Map<string, string>();
  const byId = new Map<string, Row>();
  for (const row of items) {
    if (row.kind !== "tool") continue;
    const id = text(row.id);
    byId.set(id, row);
    parents.set(id, id);
    const native = text(body(row).nativeItemId);
    if (native && !parents.has(native)) parents.set(native, id);
  }
  const parentOf = (row: Row): string | undefined => {
    const ref = parentRef(row);
    if (!ref) return undefined;
    const id = parents.get(ref);
    return id && id !== text(row.id) ? id : undefined;
  };
  const rooted = (row: Row) => {
    const seen = new Set<string>([text(row.id)]);
    let current: Row | undefined = row;
    for (let depth = 0; depth < 16 && current; depth++) {
      const parent = parentOf(current);
      if (!parent) return true;
      if (seen.has(parent)) return false;
      seen.add(parent);
      current = byId.get(parent);
    }
    return false;
  };
  const top: Row[] = [];
  const nested = new Map<string, Row[]>();
  let latestPlan: Row | undefined;
  for (const row of items) {
    const parent = parentOf(row);
    if (parent && rooted(row)) {
      const list = nested.get(parent);
      if (list) list.push(row);
      else nested.set(parent, [row]);
      continue;
    }
    if (row.kind === "plan") {
      latestPlan = row;
      // A run of plan updates reads as one "updated" note at the position of the newest.
      if (top.at(-1)?.kind === "plan") top.pop();
    }
    top.push(row);
  }
  return { top, nested, latestPlan };
}

export interface PlanEntry {
  step: string;
  status: "pending" | "in_progress" | "completed";
}
export function planEntries(row: Row | undefined): PlanEntry[] {
  if (!row) return [];
  const entries = body(row).entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Row;
    const status = ["pending", "in_progress", "completed"].includes(text(value.status))
      ? (text(value.status) as PlanEntry["status"])
      : "pending";
    return text(value.step) ? [{ step: text(value.step), status }] : [];
  });
}
export function planProgress(entries: PlanEntry[]) {
  const done = entries.filter((entry) => entry.status === "completed").length;
  return {
    done,
    total: entries.length,
    current: entries.find((entry) => entry.status === "in_progress"),
  };
}

/**
 * Reuses the previous nested lists, and the previous map, when their rows are unchanged, so the
 * context that feeds tool rows stays referentially stable while unrelated rows stream.
 */
export function stableNested(
  previous: Map<string, Row[]> | undefined,
  next: Map<string, Row[]>,
): Map<string, Row[]> {
  if (!previous) return next;
  let same = previous.size === next.size;
  const result = new Map<string, Row[]>();
  for (const [key, rows] of next) {
    const before = previous.get(key);
    const equal =
      before !== undefined &&
      before.length === rows.length &&
      before.every((row, index) => row === rows[index]);
    result.set(key, equal ? before : rows);
    if (!equal) same = false;
  }
  return same ? previous : result;
}
