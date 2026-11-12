import { body, text } from "@zoltbot/ui/chat/types";
import {
  type ChiefRank,
  chiefName,
  chiefThreadId,
  chiefTriage,
  chiefWakePrefix,
  compareQueue,
} from "@zoltbot/ui/chief/data";
import {
  currentResult,
  groupTasks,
  holdText,
  placeName,
  stateLabels,
} from "@zoltbot/ui/tasks/view";
import {
  type DispatchGroup,
  type DispatchPlace,
  defaultProfileForPlace,
  deriveTaskTitle,
  dispatchGroups,
  resolvePlace,
  scopeRows,
} from "./dispatch.js";
import { diffTotals, interactionType, typeLabels } from "./interactions.js";
import { toolTitle } from "./timeline.js";
import type { Row, Snapshot } from "./transport.js";

// Pure selectors from the snapshot to what the screens show. No React here, so tests cover them.

export { groupTitles, stateLabels } from "@zoltbot/ui/tasks/view";
export {
  currentResult,
  type DispatchGroup,
  type DispatchPlace,
  defaultProfileForPlace,
  deriveTaskTitle,
  dispatchGroups,
  holdText,
  resolvePlace,
  scopeRows,
  text,
};
export {
  childSummary,
  interactionLine,
  type TranscriptRow,
  toolTitle,
  transcript,
} from "./timeline.js";

const rows = (snapshot: Snapshot, kind: string): Row[] => snapshot.entities[kind] ?? [];
const live = (row: Row) => row.archived !== true;
const byId = (list: Row[], id: unknown) => list.find((row) => row.id === id);

/** "Zolt › App" for anything that has a projectId and a node. */
export function place(snapshot: Snapshot, row: Row | undefined): string {
  if (!row) return "";
  return placeName(row, rows(snapshot, "project"), rows(snapshot, "subproject")).replaceAll(
    " / ",
    " › ",
  );
}

/** Short age: "now", "2 min", "3 h", "yesterday", "Mon", "Oct 30". */
export function ago(at: unknown, now = Date.now()): string {
  const time = Date.parse(text(at));
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 12) return `${Math.round(minutes / 60)} h`;
  const day = (value: number) => new Date(value).toDateString();
  if (day(time) === day(now)) return `${Math.round(minutes / 60)} h`;
  if (day(time) === day(now - 86_400_000)) return "yesterday";
  const date = new Date(time);
  if (minutes < 60 * 24 * 6) return date.toLocaleDateString("en-US", { weekday: "short" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** `ago` as a phrase that reads after "Last seen" or "Paired": "5 min ago", "yesterday", "on Sun". */
export function since(at: unknown, now = Date.now()): string {
  const short = ago(at, now);
  if (!short || short === "yesterday") return short;
  if (short === "now") return "just now";
  return / (min|h)$/.test(short) ? `${short} ago` : `on ${short}`;
}

/** Stable hue 1..8 for a profile id, the same hash the desktop uses (components/identity.ts). */
export function avatarHue(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  return ((hash >>> 0) % 8) + 1;
}

export const profiles = (snapshot: Snapshot) =>
  rows(snapshot, "agent").filter((row) => live(row) && row.hidden !== true);
export const profileName = (snapshot: Snapshot, id: unknown) =>
  text(byId(rows(snapshot, "agent"), id)?.name) || "Agent";
export const definitionName = (snapshot: Snapshot, id: unknown) =>
  text(byId(rows(snapshot, "agentDefinition"), id)?.displayName) || text(id);

/** Interactions the person answers in the chat card; approvals also get quick actions. */
export type AskKind = "question" | "plan" | "form" | "gate";
/** Zolt's triage of an item, when it has one, and what the queue order needs. */
interface Ranked {
  why?: string;
  rank?: ChiefRank;
  urgency?: string;
  createdAt: string;
}
export type NeedsYouItem = Ranked &
  (
    | {
        kind: "approval";
        id: string;
        version: number;
        title: string;
        meta: string;
        command: string;
        threadId: string;
        /** Offered native choices, so quick actions show only what the request allows. */
        choices: string[];
        diff: { files: number; added: number; removed: number };
      }
    | {
        kind: AskKind;
        id: string;
        version: number;
        title: string;
        meta: string;
        threadId: string;
        label: string;
        options: Row[];
        itemId: string;
      }
    | { kind: "review"; id: string; revision: number; title: string; meta: string; summary: string }
  );

const needsOrder: Record<NeedsYouItem["kind"], number> = {
  approval: 0,
  review: 1,
  plan: 2,
  question: 3,
  form: 4,
  gate: 5,
};

export function needsYou(snapshot: Snapshot, now = Date.now()): NeedsYouItem[] {
  const threads = rows(snapshot, "thread");
  const out: NeedsYouItem[] = [];
  for (const row of rows(snapshot, "interaction")) {
    if (row.state !== "pending") continue;
    const thread = byId(threads, row.threadId);
    const task = byId(rows(snapshot, "task"), row.taskId);
    const who = profileName(snapshot, row.agentId);
    const items = Array.isArray(row.items) ? (row.items as Row[]) : [];
    const first = items[0] ?? {};
    const context = (row.context ?? {}) as Row;
    const common = {
      id: text(row.id),
      version: Number(row.version),
      threadId: text(row.threadId),
      urgency: text(row.urgency),
      createdAt: text(row.createdAt),
    };
    const type = interactionType(row);
    if (type === "approval") {
      out.push({
        ...common,
        kind: "approval",
        title: text(row.title) || `${who} asks to continue`,
        meta: [place(snapshot, thread), text(task?.title), ago(row.createdAt, now)]
          .filter(Boolean)
          .join(" · "),
        command:
          text(context.command) ||
          (Array.isArray(context.paths) ? (context.paths as string[]).join(", ") : "") ||
          text(first.prompt),
        choices: items.flatMap((item) =>
          Array.isArray(item.choices) ? (item.choices as Row[]).map((c) => text(c.id)) : [],
        ),
        diff: diffTotals(Array.isArray(context.diffs) ? (context.diffs as Row[]) : undefined),
      });
      continue;
    }
    const label = typeLabels[type];
    out.push({
      ...common,
      kind: type,
      label,
      title:
        text(row.title) ||
        (type === "plan" ? `${who} has a plan for you to review` : text(first.prompt)),
      meta: [
        items.length > 1 ? `${label} · ${items.length} questions` : label,
        who,
        place(snapshot, thread),
      ]
        .filter(Boolean)
        .join(" · "),
      options: Array.isArray(first.options) ? (first.options as Row[]) : [],
      itemId: text(first.id),
    });
  }
  for (const task of rows(snapshot, "task"))
    if (task.state === "review")
      out.push({
        kind: "review",
        id: text(task.id),
        revision: Number(task.revision),
        title: text(task.title),
        meta: ["Task", place(snapshot, task), `Revision ${task.revision}`].join(" · "),
        summary: text(currentResult(task, rows(snapshot, "taskResult"))?.summary),
        createdAt: text(task.updatedAt),
      });
  // Zolt's order and reasons once it has triaged anything, the same order the desktop shows;
  // until then, by kind.
  const triage = chiefTriage(snapshot.entities);
  const ranked = out.some((item) => triage[item.id]);
  for (const item of out) {
    const verdict = triage[item.id];
    if (!verdict) continue;
    item.rank = verdict.rank;
    if (verdict.why.trim()) item.why = verdict.why.trim();
  }
  return out.sort(
    (a, b) => (ranked ? compareQueue(triage, a, b) : 0) || needsOrder[a.kind] - needsOrder[b.kind],
  );
}

/** The Zolt card on Home: who it is, its thread and the newest thing it said. */
export interface ZoltSummary {
  name: string;
  threadId?: string;
  latest?: { text: string; at: string; brief: boolean };
  working: boolean;
}
export function zolt(snapshot: Snapshot): ZoltSummary {
  const name = chiefName(snapshot.entities);
  const threadId = chiefThreadId(snapshot.entities);
  if (!threadId) return { name, working: false };
  const items = rows(snapshot, "item")
    .filter((item) => item.threadId === threadId)
    .sort((a, b) => Number(b.seq) - Number(a.seq));
  // Turns a wake-up started hold notes to itself; only its notices and briefs are for you.
  const wakeTurns = new Set(
    items
      .filter(
        (item) =>
          item.kind === "user" &&
          text(item.id).startsWith(chiefWakePrefix) &&
          !text(item.id).startsWith(`${chiefWakePrefix}brief:`),
      )
      .map((item) => text(item.turnId))
      .filter(Boolean),
  );
  const said = items.find(
    (item) =>
      ((item.kind === "note" && body(item).code === "chief_notify") ||
        (item.kind === "message" && !wakeTurns.has(text(item.turnId)))) &&
      text(body(item).text).trim(),
  );
  // A brief is the reply to the daemon's `chief-wake:brief:` item in the same turn.
  const brief =
    !!said &&
    items.some(
      (item) =>
        item.kind === "user" &&
        item.turnId === said.turnId &&
        text(item.id).startsWith(`${chiefWakePrefix}brief:`),
    );
  return {
    name,
    threadId,
    ...(said
      ? { latest: { text: text(body(said).text).trim(), at: text(said.createdAt), brief } }
      : {}),
    working: !!runningTurn(snapshot, threadId),
  };
}

/** Chats whose last turn ended in the past day and are idle now, newest first. */
export interface DoneRow {
  threadId: string;
  title: string;
  agentId: string;
  who: string;
  at: string;
  failed: boolean;
}
export function recentlyDone(snapshot: Snapshot, now = Date.now(), limit = 5): DoneRow[] {
  const chief = chiefThreadId(snapshot.entities);
  const last = new Map<string, Row>();
  for (const turn of rows(snapshot, "turn")) {
    const id = text(turn.threadId);
    const seen = last.get(id);
    if (!seen || text(turn.startedAt) > text(seen.startedAt)) last.set(id, turn);
  }
  const out: DoneRow[] = [];
  for (const [threadId, turn] of last) {
    if (threadId === chief || (turn.status !== "completed" && turn.status !== "failed")) continue;
    const at = text(turn.endedAt);
    if (!at || now - Date.parse(at) > 86_400_000) continue;
    const thread = byId(rows(snapshot, "thread"), threadId);
    if (!thread || !live(thread)) continue;
    out.push({
      threadId,
      title: text(thread.title),
      agentId: text(thread.agentId),
      who: profileName(snapshot, thread.agentId),
      at,
      failed: turn.status === "failed",
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** What the agent is doing right now: a running tool first, else its newest item. */
export function activity(snapshot: Snapshot, threadId: string): string {
  const items = rows(snapshot, "item")
    .filter((item) => item.threadId === threadId)
    .sort((a, b) => Number(b.seq) - Number(a.seq));
  const tool = items.find((item) => item.kind === "tool" && body(item).status === "running");
  if (tool) return toolTitle(tool);
  const latest = items[0];
  if (!latest) return "Starting";
  return latest.kind === "thought" ? "Thinking" : "Writing";
}

export interface WorkingRow {
  threadId: string;
  title: string;
  agentId: string;
  who: string;
  place: string;
  activity: string;
  isTask: boolean;
}
export function workingNow(snapshot: Snapshot): WorkingRow[] {
  const running = new Set(
    rows(snapshot, "turn")
      .filter((turn) => turn.status === "running")
      .map((turn) => text(turn.threadId)),
  );
  return rows(snapshot, "thread")
    .filter((thread) => running.has(text(thread.id)))
    .map((thread) => ({
      threadId: text(thread.id),
      title: text(thread.title),
      agentId: text(thread.agentId),
      who: profileName(snapshot, thread.agentId),
      place: place(snapshot, thread),
      activity: activity(snapshot, text(thread.id)),
      isTask: Boolean(thread.taskId),
    }));
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  directions: Row[];
  counts: { needsYou: number; running: number; queued: number };
}
export function projectSummaries(snapshot: Snapshot): ProjectSummary[] {
  const tasks = rows(snapshot, "task");
  const pending = rows(snapshot, "interaction").filter((row) => row.state === "pending");
  return rows(snapshot, "project")
    .filter(live)
    .map((project) => {
      const own = tasks.filter((task) => task.projectId === project.id);
      const threads = new Set(
        rows(snapshot, "thread")
          .filter((t) => t.projectId === project.id)
          .map((t) => t.id),
      );
      const roots = Array.isArray(project.roots) ? (project.roots as Row[]) : [];
      return {
        id: text(project.id),
        name: text(project.name),
        path: text(roots[0]?.path),
        directions: rows(snapshot, "subproject").filter(
          (d) => live(d) && d.projectId === project.id,
        ),
        counts: {
          needsYou:
            own.filter((task) => task.state === "review" || task.state === "failed").length +
            pending.filter((row) => threads.has(row.threadId)).length,
          running: own.filter((task) => task.state === "running").length,
          queued: own.filter((task) => task.state === "queued").length,
        },
      };
    });
}
export function countsText(counts: ProjectSummary["counts"]) {
  const parts = [
    counts.needsYou ? `${counts.needsYou} needs you` : "",
    counts.running ? `${counts.running} running` : "",
    counts.queued ? `${counts.queued} queued` : "",
  ].filter(Boolean);
  return parts.join(" · ") || "Quiet";
}

export function taskGroups(snapshot: Snapshot) {
  return groupTasks(rows(snapshot, "task").filter(live));
}
export const taskStateLabel = (task: Row) => stateLabels[text(task.state)] ?? text(task.state);

/** Tasks and chats in one direction, newest first, for the project detail screen. */
export function directionRows(snapshot: Snapshot, directionId: string) {
  return scopeRows(snapshot, { type: "subproject", id: directionId });
}

/** Chats newest first, with Zolt's own thread pinned on top. */
export function chats(snapshot: Snapshot) {
  const working = new Set(workingNow(snapshot).map((row) => row.threadId));
  const chief = chiefThreadId(snapshot.entities);
  return rows(snapshot, "thread")
    .filter(live)
    .sort(
      (a, b) =>
        Number(b.id === chief) - Number(a.id === chief) ||
        text(b.lastActivityAt).localeCompare(text(a.lastActivityAt)),
    )
    .map((thread) => ({
      thread,
      working: working.has(text(thread.id)),
      chief: thread.id === chief,
    }));
}

/** The running turn of a thread, if any, so the composer can offer Stop. */
export const runningTurn = (snapshot: Snapshot, threadId: string) =>
  rows(snapshot, "turn").find((turn) => turn.threadId === threadId && turn.status === "running");
