import type { InjectionFragment } from "@zoltbot/core";
import type { Store } from "@zoltbot/store";
import { type ChiefState, chiefNotes, chiefThreadId } from "./identity.js";
import { chiefInbox } from "./inbox.js";
import { agreement, chiefQueue, lessonCandidates, queueOrder } from "./queue.js";
import { timerLines } from "./timers.js";

// The chief's view of every chat, built from records with no model call (file 13 section 3.2).

export type ChiefChatStatus =
  | "needs_you"
  | "working"
  | "queued"
  | "held"
  | "awaiting_review"
  | "failed"
  | "done"
  | "idle";
export interface ChiefChat {
  id: string;
  title: string;
  /** "Workspace › Team", or "" for a chat outside every workspace. */
  place: string;
  projectId?: string;
  status: ChiefChatStatus;
  executionState:
    | "needs_you"
    | "working"
    | "queued_input"
    | "held"
    | "blocked"
    | "awaiting_review"
    | "accepted"
    | "failed"
    | "done"
    | "idle";
  queuedInputCount?: number;
  taskId?: string;
  taskState?: string;
  holdReason?: string;
  hasSubmittedResult?: boolean;
  reviewState?: string;
  /** What is waiting on the person, for `needs_you`. */
  waiting?: string;
  lastActivityAt: string;
  note?: string;
}
const recentMs = 24 * 60 * 60_000;
const text = (value: unknown) => (typeof value === "string" ? value : "");

function place(state: ChiefState, thread: Record<string, unknown>) {
  const node = thread.node as { type?: string; id?: string } | undefined,
    names: string[] = [],
    seen = new Set<string>();
  let projectId = text(thread.projectId);
  let id = node?.type === "subproject" ? text(node.id) : "";
  while (id && !seen.has(id) && names.length < 3) {
    seen.add(id);
    const row = state.subproject?.find((entry) => entry.id === id);
    if (!row) break;
    names.unshift(text(row.name));
    projectId = text(row.projectId) || projectId;
    id = text(row.parentId);
  }
  const project = state.project?.find((row) => row.id === projectId);
  return {
    projectId: projectId || undefined,
    label: [project ? text(project.name) : "", ...names].filter(Boolean).join(" › "),
  };
}

/** Every live chat except the chief's own, newest activity first. */
export function chiefChats(state: ChiefState, now = new Date()): ChiefChat[] {
  const self = chiefThreadId(state),
    notes = chiefNotes(state).chats;
  const waiting = new Map<string, string>(),
    running = new Set<string>(),
    latest = new Map<string, Record<string, unknown>>();
  for (const row of state.interaction ?? [])
    if (row.state === "pending" && !waiting.has(text(row.threadId))) {
      const items = row.items as { prompt?: string }[] | undefined;
      waiting.set(
        text(row.threadId),
        `${text(row.type)}: ${text(row.title) || text(items?.[0]?.prompt)}`.slice(0, 160),
      );
    }
  for (const row of state.turn ?? []) {
    const id = text(row.threadId);
    if (row.status === "running") running.add(id);
    const previous = latest.get(id);
    if (!previous || text(row.startedAt) > text(previous.startedAt)) latest.set(id, row);
  }
  const queuedCounts = new Map<string, number>();
  for (const row of state.item ?? []) {
    if (row.kind === "user" && (row.body as { queueState?: unknown })?.queueState === "queued") {
      const id = text(row.threadId);
      queuedCounts.set(id, (queuedCounts.get(id) ?? 0) + 1);
    }
  }
  const resultTaskIds = new Set((state.taskResult ?? []).map((row) => text(row.taskId)));
  const isRecent = (at: unknown) => {
    const age = now.getTime() - new Date(text(at)).getTime();
    return age >= 0 && age < recentMs;
  };
  const chats: ChiefChat[] = [];
  for (const thread of state.thread ?? []) {
    const id = text(thread.id);
    if (thread.archived || id === self) continue;
    const turn = latest.get(id),
      where = place(state, thread),
      note = notes[id]?.text,
      queuedInputCount = queuedCounts.get(id) ?? 0;
    const matchingTasks = (state.task ?? []).filter(
      (row) =>
        row.state !== "cancelled" &&
        (row.threadId === id || (typeof thread.taskId === "string" && row.id === thread.taskId)),
    );
    const linkedTask =
      matchingTasks.find((row) => !["completed", "failed"].includes(text(row.state))) ??
      matchingTasks.at(-1);
    const taskState = linkedTask ? text(linkedTask.state) : undefined;
    const holdReason = linkedTask?.holdReason ? text(linkedTask.holdReason) : undefined;
    const rawReviewState = linkedTask?.reviewState ? text(linkedTask.reviewState) : undefined;
    const reviewState = rawReviewState === "accept" ? "accepted" : rawReviewState;
    const hasSubmittedResult = linkedTask ? resultTaskIds.has(text(linkedTask.id)) : undefined;
    const isTaskHeld =
      taskState === "blocked" ||
      (taskState === "queued" && (linkedTask?.planned === true || Boolean(holdReason)));
    let status: ChiefChatStatus;
    let executionState: ChiefChat["executionState"];
    if (waiting.has(id)) {
      status = "needs_you";
      executionState = "needs_you";
    } else if (running.has(id)) {
      status = "working";
      executionState = "working";
    } else if (isTaskHeld) {
      status = "held";
      executionState = taskState === "blocked" ? "blocked" : "held";
    } else if (taskState === "review") {
      status = "awaiting_review";
      executionState = "awaiting_review";
    } else if (queuedInputCount > 0) {
      status = "queued";
      executionState = "queued_input";
    } else if (taskState === "failed" || (turn?.status === "failed" && isRecent(turn.endedAt))) {
      status = "failed";
      executionState = "failed";
    } else if (taskState === "completed" && reviewState === "accepted") {
      status = isRecent(linkedTask?.updatedAt) || isRecent(turn?.endedAt) ? "done" : "idle";
      executionState = "accepted";
    } else if (turn?.status === "completed" && isRecent(turn.endedAt)) {
      status = "done";
      executionState = "done";
    } else {
      status = "idle";
      executionState = "idle";
    }
    chats.push({
      id,
      title: text(thread.title) || "Chat",
      place: where.label,
      ...(where.projectId ? { projectId: where.projectId } : {}),
      status,
      executionState,
      ...(queuedInputCount > 0 ? { queuedInputCount } : {}),
      ...(linkedTask && taskState ? { taskId: text(linkedTask.id), taskState } : {}),
      ...(holdReason ? { holdReason } : {}),
      ...(hasSubmittedResult !== undefined ? { hasSubmittedResult } : {}),
      ...(reviewState ? { reviewState } : {}),
      ...(waiting.has(id) ? { waiting: waiting.get(id) as string } : {}),
      lastActivityAt: text(thread.lastActivityAt),
      ...(note ? { note } : {}),
    });
  }
  return chats.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

const sections: [ChiefChatStatus, string, number][] = [
  ["working", "Running", 12],
  ["queued", "Queued input (not yet running)", 8],
  ["held", "Held or blocked", 8],
  ["awaiting_review", "Submitted, awaiting review (not accepted)", 8],
  ["failed", "Failed in the last 24 h", 6],
  ["done", "Finished in the last 24 h", 8],
];
const queueLimit = 12;
function queueLine(
  state: ChiefState,
  row: Record<string, unknown>,
  index: number,
  triage: ReturnType<typeof chiefQueue>["items"],
) {
  const entry = triage[text(row.id)];
  const chat = text(state.thread?.find((thread) => thread.id === row.threadId)?.title) || "a chat";
  const items = (row.items ?? []) as { prompt?: string; options?: { id: string }[] }[];
  const title = (text(row.title) || text(items[0]?.prompt)).replace(/\s+/g, " ").slice(0, 90);
  const options = items[0]?.options?.length
    ? ` options: ${items[0].options.map((option) => option.id).join("/")}`
    : "";
  const advice = entry?.recommend
    ? ` | you: ${entry.recommend.decision}${entry.recommend.choice ? ` ${entry.recommend.choice}` : ""}${entry.recommend.text ? " (draft)" : ""}, ${entry.why}`
    : entry
      ? ` | ${entry.why}`
      : "";
  return `${index + 1}. [${entry?.rank ?? "new"}] ${text(row.type)} "${title}" in "${chat}" (${text(row.id)})${options}${advice}`;
}
/** What leads sent up that Zolt has not handled: ideas until promoted or dropped, the rest for a day. */
function inboxLines(state: ChiefState, now: Date): string[] {
  const open = chiefInbox(state).filter(
    (entry) =>
      entry.status === "new" &&
      (entry.kind === "idea" || now.getTime() - Date.parse(entry.at) < recentMs),
  );
  if (!open.length) return [];
  return [
    `From leads (${open.length}; promote or drop ideas with chief_idea, clear the rest once handled):`,
    ...open
      .slice(-8)
      .map(
        (entry) =>
          `- ${entry.kind} ${entry.id} from "${entry.fromTitle}"${entry.place ? ` [${entry.place}]` : ""}${entry.untrusted ? " (read untrusted content)" : ""}: ${entry.text.replace(/\s+/g, " ").slice(0, 200)}`,
      ),
  ];
}
/** How often Zolt matched the user's call, and patterns of overrules worth a preference. */
function learningLines(state: ChiefState, now: Date): string[] {
  const queue = chiefQueue(state);
  const { agreed, total } = agreement(queue, now);
  const lines = total
    ? [`Your recommendations matched the user's call on ${agreed} of ${total} in the last 7 days.`]
    : [];
  for (const lesson of lessonCandidates(queue).slice(0, 2))
    lines.push(
      `Pattern: the user overruled you ${lesson.count} times on ${lesson.kind} (${lesson.examples.join("; ")}). Propose one preference with chief_learn citing ${lesson.evidence.join(", ")}.`,
    );
  return lines;
}
/** Characters, about 1,000 tokens: under the 1,500-token per-turn cap with room for other context. */
export const digestBudget = 4000;

/** The status block appended after each of the chief's user messages, newest state only. */
export function chiefDigest(state: ChiefState, now = new Date(), extra: string[] = []): string {
  const chats = chiefChats(state, now),
    notes = chiefNotes(state);
  const line = (chat: ChiefChat) =>
    `- ${chat.place ? `[${chat.place}] ` : ""}"${chat.title}" (${chat.id})${
      chat.waiting ? ` ${chat.waiting}` : ""
    }${chat.holdReason ? ` [hold: ${chat.holdReason}]` : ""}${
      chat.taskId && chat.status !== "working"
        ? ` [task ${chat.taskId}: ${chat.executionState}]`
        : ""
    }${chat.note ? ` | your note: ${chat.note}` : ""}`;
  const lines = [`Status at ${now.toISOString().slice(0, 16)}Z.`];
  if (notes.summary) lines.push(`Your summary: ${notes.summary.text}`);
  let omitted = 0;
  const queue = queueOrder(state),
    triage = chiefQueue(state).items;
  if (queue.length) {
    const untriaged = queue.filter((row) => !triage[text(row.id)]).length;
    lines.push(
      `Needs you, in the user's queue order (${queue.length}${untriaged ? `, ${untriaged} not triaged yet` : ""}):`,
      ...queue.slice(0, queueLimit).map((row, index) => queueLine(state, row, index, triage)),
    );
    omitted += Math.max(0, queue.length - queueLimit);
  }
  for (const [status, title, limit] of sections) {
    const rows = chats.filter((chat) => chat.status === status);
    if (!rows.length) continue;
    lines.push(`${title} (${rows.length}):`, ...rows.slice(0, limit).map(line));
    omitted += Math.max(0, rows.length - limit);
  }
  const idle = chats.filter((chat) => chat.status === "idle").length;
  if (lines.length === 1 + (notes.summary ? 1 : 0)) lines.push("Nothing is running or waiting.");
  lines.push(
    ...inboxLines(state, now),
    ...timerLines(state),
    ...learningLines(state, now),
    ...extra,
  );
  if (idle) lines.push(`${idle} other chats are idle.`);
  let digest = lines.join("\n");
  if (digest.length > digestBudget) {
    digest = digest.slice(0, digestBudget - 120);
    digest = digest.slice(0, digest.lastIndexOf("\n"));
    omitted += 1;
  }
  return omitted ? `${digest}\nMore not shown: call chief_overview.` : digest;
}

/** Only the chief's thread gets the digest; every other chat's input is unchanged. */
export function chiefFragments(
  store: Pick<Store, "snapshot">,
  threadId: string,
): InjectionFragment[] {
  const state = store.snapshot([
    "settings",
    "thread",
    "turn",
    "item",
    "interaction",
    "project",
    "subproject",
    "task",
    "taskResult",
  ]);
  if (chiefThreadId(state) !== threadId) return [];
  return [
    { id: "chief.status", kind: "status", text: chiefDigest(state), reference: "chief_overview" },
  ];
}
