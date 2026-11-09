import type { TimelineRow } from "../artifacts/occurrences.js";
import { toolSummary } from "./tools/tool-data.js";
import { body, type Row, text } from "./types.js";

export type ActivityRow = { type: "activity"; key: string; items: Row[] };
export type ConversationRow = TimelineRow | ActivityRow;

const failedStatus = (status: unknown) => status === "error" || status === "denied";
/**
 * A failed step the agent fixed itself: a later step in the same turn of the same kind and target
 * succeeded. Those read as "Fixed on retry" and fold away with routine work instead of staying red.
 */
export function markRecovered(items: Row[]): Row[] {
  const key = (item: Row) =>
    `${text(item.turnId)}|${text(body(item).kind)}|${toolSummary(body(item))}`;
  const passed = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind === "tool" && body(item).status === "ok") passed.set(key(item), index);
  });
  let changed = false;
  const result = items.map((item, index) => {
    if (item.kind !== "tool" || body(item).status !== "error" || body(item).interactive === true)
      return item;
    if ((passed.get(key(item)) ?? -1) <= index) return item;
    changed = true;
    return { ...item, body: { ...body(item), recovered: true } };
  });
  return changed ? result : items;
}

/** Group only adjacent routine work. Approvals, failures and artifacts keep their positions. */
export function groupActivity(rows: TimelineRow[]): ConversationRow[] {
  const result: ConversationRow[] = [];
  for (const row of rows) {
    const item = row.type === "message" ? row.item : undefined;
    const value = item && body(item);
    const routine =
      item &&
      value &&
      value.partial !== true &&
      (item.kind === "thought" ||
        (item.kind === "tool" &&
          value.interactive !== true &&
          (!failedStatus(value.status) || value.recovered === true)));
    if (!routine || !item) {
      result.push(row);
      continue;
    }
    const previous = result.at(-1);
    if (previous?.type === "activity" && previous.items[0]?.turnId === item.turnId)
      previous.items.push(item);
    else result.push({ type: "activity", key: `activity:${text(item.id)}`, items: [item] });
  }
  return result;
}

export function activityLabel(items: Row[]) {
  const active = items.findLast((item) => {
    const value = body(item);
    return value.streaming === true || value.status === "running";
  });
  if (active) {
    if (active.kind === "thought") return "Thinking…";
    return runningToolLabel(body(active));
  }
  return summarizeSteps(items);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
// What a finished group of tool calls did, by tool kind. Changes come first, as T3 orders them.
const actions: Record<string, { rank: number; say(count: number, files: number): string }> = {
  edit: { rank: 0, say: (n, files) => `Edited ${plural(files || n, "file", "files")}` },
  delete: { rank: 0, say: (n, files) => `Deleted ${plural(files || n, "file", "files")}` },
  move: { rank: 0, say: (n) => `Moved ${plural(n, "file", "files")}` },
  execute: { rank: 0, say: (n) => `Ran ${plural(n, "command", "commands")}` },
  agent: { rank: 0, say: (n) => `Ran ${plural(n, "subagent", "subagents")}` },
  read: { rank: 1, say: (n, files) => `Read ${plural(files || n, "file", "files")}` },
  search: { rank: 1, say: (n) => `Searched ${plural(n, "time", "times")}` },
  fetch: { rank: 1, say: (n) => `Fetched ${plural(n, "page", "pages")}` },
  other: { rank: 2, say: (n) => `Used ${plural(n, "tool", "tools")}` },
};

/** The distinct files a tool touched, from its diffs or reported locations. */
function toolFiles(value: Row) {
  const paths = [
    ...(Array.isArray(value.diffs) ? (value.diffs as Row[]).map((diff) => text(diff.path)) : []),
    ...(Array.isArray(value.locations)
      ? (value.locations as Row[]).map((location) => text(location.path))
      : []),
  ];
  return paths.filter(Boolean);
}

/**
 * One sentence for a finished group: "Read 3 files and ran 2 commands". The two most important
 * kinds are named; anything else becomes "N other actions". Reasoning alone reads "Thought".
 */
export function summarizeSteps(items: Row[]) {
  const tools = items.filter((item) => item.kind === "tool");
  if (!tools.length) {
    const thoughts = items.filter((item) => item.kind === "thought").length;
    return thoughts > 1 ? `Thought (×${thoughts})` : "Thought";
  }
  const buckets = new Map<string, { count: number; files: Set<string> }>();
  for (const item of tools) {
    const value = body(item),
      kind =
        text(value.kind) in actions && text(value.kind) !== "other" ? text(value.kind) : "other";
    const bucket = buckets.get(kind) ?? { count: 0, files: new Set<string>() };
    bucket.count++;
    for (const path of toolFiles(value)) bucket.files.add(path);
    buckets.set(kind, bucket);
  }
  const order = [...buckets.keys()];
  const top = [...order]
    .sort(
      (a, b) =>
        (actions[a]?.rank ?? 2) - (actions[b]?.rank ?? 2) || order.indexOf(a) - order.indexOf(b),
    )
    .slice(0, 2)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const rest = order
    .filter((kind) => !top.includes(kind))
    .reduce((sum, kind) => sum + (buckets.get(kind)?.count ?? 0), 0);
  const clauses = top.map((kind) => {
    const bucket = buckets.get(kind) as { count: number; files: Set<string> };
    return (actions[kind] ?? (actions.other as (typeof actions)[string])).say(
      bucket.count,
      bucket.files.size,
    );
  });
  if (rest) clauses.push(`Performed ${plural(rest, "other action", "other actions")}`);
  const fixed = tools.filter((item) => body(item).recovered === true).length;
  if (fixed) clauses.push(`Fixed ${plural(fixed, "failed step", "failed steps")}`);
  const [first = "", ...others] = clauses.map((clause, index) =>
    index ? clause.charAt(0).toLowerCase() + clause.slice(1) : clause,
  );
  if (!others.length) return first;
  if (others.length === 1) return `${first} and ${others[0]}`;
  return `${first}, ${others.slice(0, -1).join(", ")}, and ${others.at(-1)}`;
}

/** Labels describe reported tools, never inferred or simulated work. */
export function runningToolLabel(value: Row) {
  const kind = text(value.kind);
  if (/skill/i.test(`${text(value.name)} ${text(value.title)}`)) return "Checking skills…";
  const labels: Record<string, string> = {
    read: "Reading files…",
    search: "Searching…",
    execute: "Running a command…",
    edit: "Editing files…",
    fetch: "Looking up information…",
    agent: "Working with a subagent…",
  };
  return labels[kind] ?? "Working…";
}
