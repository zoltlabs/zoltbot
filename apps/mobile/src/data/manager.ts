import { body, text } from "@zoltbot/ui/chat/types";
import type { TranscriptRow } from "./timeline.js";
import type { Row, Snapshot } from "./transport.js";

// What a manager's chat shows about the work it hands out: one card per turn that assigned
// tasks, a result card when a task reaches review, one centered line per message between agents
// or supervision notice, and a waiting line while it waits on its own work. A port of the Mac's
// zolt/manager-cards.ts, read from the same snapshot rows.

export type TaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";

/** A chat named in a card or a notice; `threadId` is null when the chat is archived. */
export interface ChatRef {
  name: string;
  threadId: string | null;
  agentId: string;
}

/** One compact centered line: a message between agents, a supervision notice or a wait. */
export interface NoticeLine {
  kind: "team" | "supervision" | "wait" | "continue" | "waiting" | "call";
  from?: ChatRef;
  to?: ChatRef;
  verb?: string;
  text: string;
  meta?: string;
  /** The full message, shown when the line is expanded. */
  detail?: string;
  /** Set on a waiting line: the chat that waits and its wait, for Wake now. */
  threadId?: string;
  waitId?: string;
}

export interface DelegationRow {
  taskId: string;
  revision: number;
  owner: ChatRef;
  title: string;
  status: TaskStatus;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  costUsd?: number;
  budgetUsd?: number;
}

export type ManagerCard =
  | { kind: "delegation"; rows: DelegationRow[] }
  | {
      kind: "result";
      taskId: string;
      revision: number;
      owner: ChatRef;
      title: string;
      status: TaskStatus;
      files: string[];
      tests?: "passed" | "failed" | "partial";
      /** What the test evidence calls the run, such as "14 tests". */
      testLabel?: string;
      costUsd?: number;
      budgetUsd?: number;
      /** The manager's words right after the result arrived. */
      note?: string;
      manager: string;
    };

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const list = (snapshot: Snapshot, kind: string): Row[] => snapshot.entities[kind] ?? [];
const find = (snapshot: Snapshot, kind: string, id: unknown) =>
  id ? list(snapshot, kind).find((row) => row.id === id) : undefined;
const line = (value: string) => value.replace(/\s+/g, " ").trim();

export function chatRef(snapshot: Snapshot, id: unknown): ChatRef {
  const thread = find(snapshot, "thread", id);
  const profile = find(snapshot, "agent", thread?.agentId);
  // A task chat is titled after the task, so it goes by the teammate who owns it.
  const named =
    thread?.kind === "task"
      ? text(profile?.name) || text(thread?.title)
      : text(thread?.title) || text(profile?.name);
  return {
    name: named || "Agent",
    threadId: thread && thread.archived !== true ? text(thread.id) : null,
    agentId: text(thread?.agentId),
  };
}

/** A teammate's own words, without the routing line the daemon puts above them. */
function words(message: Row | undefined): string {
  const parts = Array.isArray(message?.body) ? (message.body as Row[]) : [];
  const all = parts
    .filter((part) => part.type === "text")
    .map((part) => text(part.text))
    .join("\n");
  return all.startsWith("[") && all.includes("\n") ? all.slice(all.indexOf("\n") + 1) : all;
}
const fromOwner = (message: Row | undefined) =>
  message?.origin === "human" || record(message?.from).kind === "human";

const STATUS_WORDS: Record<string, { verb: string; meta: string }> = {
  review: { verb: "finished", meta: "ready for review" },
  completed: { verb: "finished", meta: "accepted" },
  failed: { verb: "couldn't finish", meta: "failed" },
  cancelled: { verb: "stopped", meta: "stopped" },
  blocked: { verb: "is blocked on", meta: "blocked" },
  held: { verb: "is held on", meta: "on hold" },
  checkpoint_missed: { verb: "missed the checkpoint for", meta: "past its date" },
  handoff: { verb: "handed over", meta: "now yours" },
};
const WAIT_WORDS: Record<string, string> = {
  finished: "everything finished",
  fallback: "fallback time passed",
  owner: "woken by you",
};

/**
 * The notice line for a daemon-written input in a chat: a teammate's message or assignment, a
 * supervision notice or the end of a team wait. Undefined for anything else.
 */
export function noticeFor(snapshot: Snapshot, item: Row): NoticeLine | undefined {
  const value = body(item);
  const notice = record(value.notice);
  const kind = text(notice.kind);
  if (kind === "supervision") {
    const task = find(snapshot, "task", notice.taskId);
    if (text(notice.state) === "initiative")
      return { kind: "supervision", verb: "Initiative approved:", text: text(notice.preview) };
    const known = STATUS_WORDS[text(notice.state)];
    return {
      kind: "supervision",
      from: chatRef(snapshot, task?.threadId),
      verb: known?.verb ?? "updated",
      text: text(task?.title) || text(notice.taskId),
      meta: text(notice.preview) || known?.meta || text(notice.state),
    };
  }
  if (kind === "continue")
    return {
      kind: "continue",
      from: chatRef(snapshot, item.threadId),
      verb: "continued automatically",
      text: "",
    };
  if (kind === "wait")
    return {
      kind: "wait",
      from: chatRef(snapshot, item.threadId),
      verb: "stopped waiting",
      text: "",
      meta: WAIT_WORDS[text(notice.state)] ?? "",
    };
  const sourceId = text(notice.messageId) || text(value.sourceMessageId);
  const message = find(snapshot, "message", sourceId);
  if (kind !== "team" && !(value.origin === "agent" && message)) return undefined;
  const type = text(notice.type) || (message?.kind === "task" ? "brief" : "update");
  const full = words(message) || text(notice.preview);
  return {
    kind: "team",
    from: fromOwner(message)
      ? { name: "You", threadId: null, agentId: "" }
      : chatRef(snapshot, text(notice.fromThreadId) || message?.fromThread),
    to: chatRef(snapshot, item.threadId),
    text: line(type === "brief" ? text(notice.preview) || full : full),
    ...(full ? { detail: full } : {}),
  };
}

/** "Mira → Theo: use the EU fixtures", "Theo finished Add test · ready for review". */
export function noticeText(notice: NoticeLine): string {
  if (notice.kind === "waiting") return `Waiting on ${notice.text}`;
  if (notice.to)
    return `${notice.from?.name ?? "Agent"} → ${notice.to.name}: ${notice.text}`.trim();
  return [
    [notice.from?.name, notice.verb, notice.text].filter(Boolean).join(" "),
    notice.meta ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
function cost(snapshot: Snapshot, task: Row): number | undefined {
  const sessions = new Set(
    list(snapshot, "session")
      .filter((session) => task.threadId && session.threadId === task.threadId)
      .map((session) => session.id),
  );
  const usage = list(snapshot, "usage").filter(
    (row) =>
      (row.taskId === task.id || sessions.has(row.sessionId)) && typeof row.costUsd === "number",
  );
  return usage.length ? sum(usage.map((row) => Number(row.costUsd))) : undefined;
}
function started(snapshot: Snapshot, task: Row): string | undefined {
  return list(snapshot, "turn")
    .filter((turn) => task.threadId && turn.threadId === task.threadId)
    .map((turn) => text(turn.startedAt))
    .filter((at) => at >= text(task.createdAt))
    .sort()[0];
}
const DONE = ["review", "completed", "failed", "cancelled"];
export const ACTIVE: TaskStatus[] = ["queued", "running", "blocked"];
function reason(snapshot: Snapshot, task: Row): string | undefined {
  if (task.state !== "queued" && task.state !== "blocked") return undefined;
  const waiting = (Array.isArray(task.dependencies) ? (task.dependencies as string[]) : [])
    .map((id) => find(snapshot, "task", id))
    .filter((dep) => dep && dep.state !== "completed");
  if (waiting.length) return `Waits on ${waiting.map((dep) => text(dep?.title)).join(", ")}`;
  const hold = text(task.holdReason);
  if (hold.startsWith("at_limit")) return "At limit";
  return hold ? hold.split(":")[0]?.replaceAll("_", " ") : undefined;
}
function delegationRow(snapshot: Snapshot, task: Row): DelegationRow {
  const status = text(task.state) as TaskStatus;
  const startedAt = status === "queued" ? undefined : started(snapshot, task);
  const costUsd = cost(snapshot, task);
  const why = reason(snapshot, task);
  return {
    taskId: text(task.id),
    revision: Number(task.revision) || 1,
    owner: chatRef(snapshot, task.threadId),
    title: text(task.title),
    status,
    ...(why ? { reason: why } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(DONE.includes(status) ? { finishedAt: text(task.updatedAt) } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(typeof task.budgetUsd === "number" ? { budgetUsd: task.budgetUsd } : {}),
  };
}

/** Tasks this chat handed out, each with the message that assigned it. */
function delegated(snapshot: Snapshot, threadId: string) {
  const sent = new Map(
    list(snapshot, "message")
      .filter((message) => message.fromThread === threadId && message.kind === "task")
      .map((message) => [message.id, message]),
  );
  return list(snapshot, "task")
    .filter((task) => sent.has(task.sourceMessageId))
    .map((task) => ({ task, message: sent.get(task.sourceMessageId) as Row }));
}
const VALIDATION: Record<string, "passed" | "failed" | "partial"> = {
  passed: "passed",
  failed: "failed",
  partial: "partial",
};
function resultCard(snapshot: Snapshot, threadId: string, task: Row, result: Row) {
  const validation = list(snapshot, "deliverable")
    .filter((row) => row.taskId === task.id)
    .sort((a, b) => Number(b.version) - Number(a.version))[0];
  const note = list(snapshot, "item")
    .filter(
      (item) =>
        item.threadId === threadId &&
        item.kind === "message" &&
        text(item.phase) !== "commentary" &&
        text(item.createdAt) >= text(result.createdAt),
    )
    .sort((a, b) => Number(a.seq) - Number(b.seq))[0];
  const costUsd = cost(snapshot, task);
  const tests = VALIDATION[text(validation?.validationState)];
  const evidence = Array.isArray(validation?.evidence) ? (validation.evidence as Row[]) : [];
  const testLabel = text(evidence.find((row) => row.kind === "test")?.label);
  const said = note ? line(text(body(note).text)) : "";
  const card: ManagerCard = {
    kind: "result",
    taskId: text(task.id),
    revision: Number(task.revision) || 1,
    owner: chatRef(snapshot, task.threadId),
    title: text(task.title),
    status: text(task.state) as TaskStatus,
    files: Array.isArray(result.files) ? (result.files as unknown[]).map(text) : [],
    ...(tests ? { tests } : {}),
    ...(tests && testLabel ? { testLabel } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(typeof task.budgetUsd === "number" ? { budgetUsd: task.budgetUsd } : {}),
    ...(said ? { note: said.slice(0, 280) } : {}),
    manager: chatRef(snapshot, threadId).name,
  };
  return { card, after: note ? text(note.id) : undefined };
}

/** A row the manager's chat adds, and where it goes among the thread's own rows. */
export interface Placed {
  row: TranscriptRow;
  at: string;
  /** Right after this item, when it is in the list. */
  afterItem?: string;
  /** After the last row of this turn, when the turn has rows. */
  afterTurn?: string;
}
const extra = (id: string, fields: Partial<TranscriptRow>): TranscriptRow => ({
  id,
  kind: "other",
  text: "",
  streaming: false,
  ...fields,
});

/** Delegation and result cards, lines for messages this chat sent, and its waiting line. */
export function managerRows(snapshot: Snapshot, threadId: string): Placed[] {
  const out: Placed[] = [];
  const turns = list(snapshot, "turn").filter((turn) => turn.threadId === threadId);
  const groups = new Map<string, { turnId?: string; at: string; tasks: Row[] }>();
  const work = delegated(snapshot, threadId);
  for (const { task, message } of work) {
    const at = text(message.createdAt);
    const turn = turns.find(
      (row) => text(row.startedAt) <= at && (!row.endedAt || text(row.endedAt) >= at),
    );
    const key = turn ? text(turn.id) : text(message.id);
    const group = groups.get(key) ?? { ...(turn ? { turnId: key } : {}), at, tasks: [] };
    group.tasks.push(task);
    if (at < group.at) group.at = at;
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const card: ManagerCard = {
      kind: "delegation",
      rows: group.tasks
        .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)))
        .map((task) => delegationRow(snapshot, task)),
    };
    out.push({
      row: extra(`card:delegation:${key}`, { manager: card, text: delegationTitle(card.rows) }),
      at: group.at,
      ...(group.turnId ? { afterTurn: group.turnId } : {}),
    });
  }
  const results = list(snapshot, "taskResult");
  for (const { task } of work) {
    const result = results
      .filter((row) => row.taskId === task.id)
      .sort((a, b) => Number(b.revision) - Number(a.revision))[0];
    if (!result || !["review", "completed", "failed"].includes(text(task.state))) continue;
    const { card, after } = resultCard(snapshot, threadId, task, result);
    out.push({
      row: extra(`card:result:${text(task.id)}`, { manager: card, text: card.title }),
      at: text(result.createdAt),
      ...(after ? { afterItem: after } : {}),
    });
  }
  for (const message of list(snapshot, "message")) {
    if (message.fromThread !== threadId || message.kind === "task" || message.kind === "control")
      continue;
    const full = words(message);
    const notice: NoticeLine = {
      kind: "team",
      from: chatRef(snapshot, threadId),
      to: chatRef(snapshot, message.thread),
      text: line(full),
      detail: full,
    };
    out.push({
      row: extra(`notice:sent:${text(message.id)}`, { notice, text: noticeText(notice) }),
      at: text(message.createdAt),
    });
  }
  const wait = record(
    list(snapshot, "settings").find((row) => row.key === `team.wait.${threadId}`)?.value,
  );
  if (wait.status === "waiting") {
    const ids = (value: unknown) => (Array.isArray(value) ? (value as string[]) : []);
    const tasks = ids(wait.taskIds).map((id) => text(find(snapshot, "task", id)?.title) || id);
    const chats = ids(wait.chatIds).map((id) => chatRef(snapshot, id).name);
    const targets = [...tasks, ...chats];
    const count = (n: number, noun: string) => (n ? `${n} ${noun}${n === 1 ? "" : "s"}` : "");
    const notice: NoticeLine = {
      kind: "waiting",
      text:
        targets.length === 1
          ? (targets[0] as string)
          : [count(tasks.length, "task"), count(chats.length, "chat")]
              .filter(Boolean)
              .join(" and "),
      ...(targets.length > 1 ? { detail: targets.join(", ") } : {}),
      threadId,
      waitId: text(wait.id),
    };
    out.push({
      row: extra(`notice:waiting:${text(wait.id)}`, { notice, text: noticeText(notice) }),
      // Always last: it describes now, not when it started.
      at: "￿",
    });
  }
  return out;
}

export const delegationTitle = (rows: readonly DelegationRow[]) =>
  `Assigned ${rows.length} ${rows.length === 1 ? "task" : "tasks"}`;

/**
 * Puts the manager's rows among the thread's own rows: after the item or turn they belong to,
 * else before the first row that came later.
 */
export function placeRows(
  rows: TranscriptRow[],
  extras: readonly Placed[],
  items: readonly Row[],
): TranscriptRow[] {
  if (!extras.length) return rows;
  const at = new Map(items.map((item) => [text(item.id), text(item.createdAt)]));
  const turnOf = new Map(items.map((item) => [text(item.id), text(item.turnId)]));
  const result = rows.slice();
  const sorted = [...extras].sort((a, b) => a.at.localeCompare(b.at));
  for (const entry of sorted) {
    let index = -1;
    if (entry.afterItem) {
      const found = result.findIndex((row) => row.id === entry.afterItem);
      if (found >= 0) index = found + 1;
    }
    if (index < 0 && entry.afterTurn) {
      const found = result.findLastIndex((row) => turnOf.get(row.id) === entry.afterTurn);
      if (found >= 0) index = found + 1;
    }
    if (index < 0) {
      // Rows without a time of their own (artifacts) stay with the row before them.
      const found = result.findIndex((row) => {
        const when = at.get(row.id);
        return when !== undefined && when > entry.at;
      });
      index = found < 0 ? result.length : found;
    }
    result.splice(index, 0, entry.row);
  }
  return result;
}

/** "$0.73 of $4", "$4 budget", "$0.73", or "" for a card's spend. */
export function spend(costUsd?: number, budgetUsd?: number): string {
  const usd = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  if (costUsd === undefined) return budgetUsd === undefined ? "" : `${usd(budgetUsd)} budget`;
  return budgetUsd === undefined ? usd(costUsd) : `${usd(costUsd)} of ${usd(budgetUsd)}`;
}

/** The card header's total: what the tasks cost so far against their budgets. */
export function delegationSpend(rows: readonly DelegationRow[]): string {
  const costs = rows.map((row) => row.costUsd).filter((v): v is number => v !== undefined);
  const budgets = rows.map((row) => row.budgetUsd).filter((v): v is number => v !== undefined);
  return spend(costs.length ? sum(costs) : undefined, budgets.length ? sum(budgets) : undefined);
}

export const STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  completed: "Accepted",
  failed: "Failed",
  cancelled: "Stopped",
};

/** "4 min", "1 h 5 min", "under 1 min". */
export function elapsed(from: string | undefined, to: string | undefined, now: number): string {
  if (!from) return "";
  const minutes = Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 60000));
  if (minutes < 1) return "under 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

/** "Running · 4 min", "Queued · Waits on Refund endpoint". */
export function rowMeta(row: DelegationRow, now: number): string {
  return [
    STATUS_LABELS[row.status] ?? row.status,
    row.reason && ACTIVE.includes(row.status) ? row.reason : "",
    elapsed(row.startedAt, row.finishedAt, now),
  ]
    .filter(Boolean)
    .join(" · ");
}

const TESTS: Record<string, string> = {
  passed: "Tests passed",
  failed: "Tests failed",
  partial: "Some tests failed",
};
/** "14 tests passed" when the evidence counts them, otherwise "Tests passed". */
export function testsText(tests: string | undefined, label?: string): string {
  const said = tests ? (TESTS[tests] ?? "") : "";
  if (!said || !label || tests === "partial") return said;
  return `${label} ${said.slice("Tests ".length)}`;
}
/** "Theo finished Add invoice rounding test". */
export function resultTitle(card: Extract<ManagerCard, { kind: "result" }>): string {
  const verb = card.status === "failed" ? "couldn't finish" : "finished";
  return `${card.owner.name} ${verb} ${card.title}`;
}
