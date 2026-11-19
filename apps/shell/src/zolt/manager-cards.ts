import type {
  ConversationMessage,
  ConversationNotice,
  DelegationRow,
  ManagerCard,
  TaskActionInput,
  TaskStatus,
} from "../shared/ipc";
import type { Row, Snapshot } from "./daemon-client";
import { withStaffCards } from "./staff-view";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const body = (row: Row | undefined): Row =>
  row?.body && typeof row.body === "object" && !Array.isArray(row.body) ? (row.body as Row) : {};
const rows = (snapshot: Snapshot, kind: string): Row[] => snapshot.entities[kind] ?? [];
const find = (snapshot: Snapshot, kind: string, id: unknown) =>
  id ? rows(snapshot, kind).find((row) => row.id === id) : undefined;

function chat(snapshot: Snapshot, id: unknown): { name: string; botId: string | null } {
  const thread = find(snapshot, "thread", id);
  const profile = find(snapshot, "agent", thread?.agentId);
  return {
    name: text(thread?.title) || text(profile?.name) || "Agent",
    botId: thread && thread.archived !== true ? text(thread.id) : null,
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
/** A message the owner wrote, such as a channel post delivered to the lead. */
const fromOwner = (message: Row | undefined) =>
  message?.origin === "human" || body({ body: message?.from }).kind === "human";
const line = (value: string) => value.replace(/\s+/g, " ").trim();

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
 * The notice line for a daemon-written input: a teammate's message or assignment, a supervision
 * notice or the end of a team wait. Older inputs without notice metadata still read as a
 * teammate's message when their source message is known.
 */
export function noticeFor(snapshot: Snapshot, item: Row): ConversationNotice | undefined {
  const value = body(item);
  const notice = body({ body: value.notice });
  const kind = text(notice.kind);
  if (kind === "supervision") {
    const task = find(snapshot, "task", notice.taskId);
    const words = STATUS_WORDS[text(notice.state)];
    if (text(notice.state) === "initiative")
      return { kind: "supervision", verb: "Initiative approved:", text: text(notice.preview) };
    return {
      kind: "supervision",
      from: chat(snapshot, task?.threadId),
      verb: words?.verb ?? "updated",
      text: text(task?.title) || text(notice.taskId),
      meta: text(notice.preview) || words?.meta || text(notice.state),
    };
  }
  if (kind === "wait")
    return {
      kind: "wait",
      from: chat(snapshot, item.threadId),
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
      ? { name: "You", botId: null }
      : chat(snapshot, text(notice.fromThreadId) || message?.fromThread),
    to: chat(snapshot, item.threadId),
    text: line(type === "brief" ? text(notice.preview) || full : full),
    meta:
      type === "question"
        ? "asks for a reply"
        : type === "brief"
          ? "assignment"
          : type === "reply"
            ? "reply"
            : "no reply needed",
    ...(full ? { detail: full } : {}),
  };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
function cost(snapshot: Snapshot, task: Row): number | undefined {
  const sessions = new Set(
    rows(snapshot, "session")
      .filter((session) => task.threadId && session.threadId === task.threadId)
      .map((session) => session.id),
  );
  const usage = rows(snapshot, "usage").filter(
    (row) =>
      (row.taskId === task.id || sessions.has(row.sessionId)) && typeof row.costUsd === "number",
  );
  return usage.length ? sum(usage.map((row) => Number(row.costUsd))) : undefined;
}
function started(snapshot: Snapshot, task: Row): string | undefined {
  return rows(snapshot, "turn")
    .filter((turn) => task.threadId && turn.threadId === task.threadId)
    .map((turn) => text(turn.startedAt))
    .filter((at) => at >= text(task.createdAt))
    .sort()[0];
}
const DONE = ["review", "completed", "failed", "cancelled"];
function reason(snapshot: Snapshot, task: Row): string | undefined {
  if (task.state !== "queued" && task.state !== "blocked") return undefined;
  const waiting = (Array.isArray(task.dependencies) ? (task.dependencies as string[]) : [])
    .map((id) => find(snapshot, "task", id))
    .filter((dep) => dep && dep.state !== "completed");
  if (waiting.length) return `Waits on ${waiting.map((dep) => text(dep?.title)).join(", ")}`;
  const hold = text(task.holdReason);
  if (hold.startsWith("at_limit")) return "Queued: at limit";
  return hold ? hold.split(":")[0]?.replaceAll("_", " ") : undefined;
}
function delegationRow(snapshot: Snapshot, task: Row): DelegationRow {
  const owner = chat(snapshot, task.threadId);
  const status = text(task.state) as TaskStatus;
  const startedAt = status === "queued" ? undefined : started(snapshot, task);
  const costUsd = cost(snapshot, task);
  const why = reason(snapshot, task);
  return {
    taskId: text(task.id),
    revision: Number(task.revision) || 1,
    botId: owner.botId,
    owner: owner.name,
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
    rows(snapshot, "message")
      .filter((message) => message.fromThread === threadId && message.kind === "task")
      .map((message) => [message.id, message]),
  );
  return rows(snapshot, "task")
    .filter((task) => sent.has(task.sourceMessageId))
    .map((task) => ({ task, message: sent.get(task.sourceMessageId) as Row }));
}
const VALIDATION: Record<string, "passed" | "failed" | "partial"> = {
  passed: "passed",
  failed: "failed",
  partial: "partial",
};
function resultCard(snapshot: Snapshot, threadId: string, task: Row, result: Row) {
  const owner = chat(snapshot, task.threadId);
  const validation = rows(snapshot, "deliverable")
    .filter((row) => row.taskId === task.id)
    .sort((a, b) => Number(b.version) - Number(a.version))[0];
  const note = rows(snapshot, "item")
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
  const card: ManagerCard = {
    kind: "result",
    taskId: text(task.id),
    revision: Number(task.revision) || 1,
    botId: owner.botId,
    owner: owner.name,
    title: text(task.title),
    status: text(task.state) as TaskStatus,
    files: Array.isArray(result.files) ? (result.files as string[]).map(text) : [],
    ...(tests ? { tests } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(typeof task.budgetUsd === "number" ? { budgetUsd: task.budgetUsd } : {}),
    ...(note && text(body(note).text).trim()
      ? { note: line(text(body(note).text)).slice(0, 280) }
      : {}),
  };
  return { card, after: note ? text(note.id) : undefined };
}

const entry = (id: string, createdAt: string, extra: Partial<ConversationMessage>) =>
  ({
    id,
    author: "assistant",
    source: "system",
    text: "",
    createdAt,
    status: "completed",
    ...extra,
  }) as ConversationMessage;
function insertAt(list: ConversationMessage[], message: ConversationMessage, afterId?: string) {
  const after = afterId ? list.findIndex((row) => row.id === afterId) : -1;
  if (after >= 0) {
    list.splice(after + 1, 0, message);
    return;
  }
  const index = list.findIndex((row) => row.createdAt > message.createdAt);
  list.splice(index < 0 ? list.length : index, 0, message);
}

/**
 * Adds what this chat delegated to its conversation: one card per turn that assigned work, a
 * result card per submitted result, a line for each message it sent another chat, and a
 * waiting line while it waits on its own work.
 */
export function withManagerCards(
  snapshot: Snapshot,
  threadId: string,
  messages: ConversationMessage[],
): ConversationMessage[] {
  const list = messages.slice();
  const turns = rows(snapshot, "turn").filter((turn) => turn.threadId === threadId);
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
    const lastOfTurn = group.turnId
      ? list.filter((row) => row.turnId === group.turnId).at(-1)?.id
      : undefined;
    insertAt(list, entry(`card:delegation:${key}`, group.at, { card }), lastOfTurn);
  }
  const results = rows(snapshot, "taskResult");
  for (const { task } of work) {
    const result = results
      .filter((row) => row.taskId === task.id)
      .sort((a, b) => Number(b.revision) - Number(a.revision))[0];
    if (!result || !["review", "completed", "failed"].includes(text(task.state))) continue;
    const { card, after } = resultCard(snapshot, threadId, task, result);
    insertAt(list, entry(`card:result:${text(task.id)}`, text(result.createdAt), { card }), after);
  }
  for (const message of rows(snapshot, "message")) {
    if (message.fromThread !== threadId || message.kind === "task" || message.kind === "control")
      continue;
    const answered = rows(snapshot, "message").some((row) => row.replyTo === message.id);
    const full = words(message);
    insertAt(
      list,
      entry(`notice:sent:${text(message.id)}`, text(message.createdAt), {
        notice: {
          kind: "team",
          from: chat(snapshot, threadId),
          to: chat(snapshot, message.thread),
          text: line(full),
          meta: message.replyTo
            ? "reply"
            : message.expectsReply
              ? answered
                ? "answered"
                : "waiting for a reply"
              : "no reply needed",
          detail: full,
        },
      }),
    );
  }
  const wait = body({
    body: rows(snapshot, "settings").find((row) => row.key === `team.wait.${threadId}`)?.value,
  });
  if (wait.status === "waiting") {
    const ids = (value: unknown) => (Array.isArray(value) ? (value as string[]) : []);
    const tasks = ids(wait.taskIds).map((id) => text(find(snapshot, "task", id)?.title) || id);
    const chats = ids(wait.chatIds).map((id) => chat(snapshot, id).name);
    const targets = [...tasks, ...chats];
    const count = (n: number, noun: string) => (n ? `${n} ${noun}${n === 1 ? "" : "s"}` : "");
    list.push(
      entry(`notice:waiting:${text(wait.id)}`, text(wait.updatedAt), {
        notice: {
          kind: "waiting",
          from: chat(snapshot, threadId),
          verb: "is waiting for",
          text:
            targets.length === 1
              ? (targets[0] as string)
              : [count(tasks.length, "task"), count(chats.length, "chat")]
                  .filter(Boolean)
                  .join(" and "),
          ...(targets.length > 1 ? { detail: targets.join(", ") } : {}),
          threadId,
          waitId: text(wait.id),
        },
      }),
    );
  }
  return withStaffCards(snapshot, threadId, list);
}

/** Chats whose conversation shows a changed row, beyond the row's own chat. */
export function relatedThreads(snapshot: Snapshot, kind: string, row: Row): string[] {
  const forTask = (task: Row | undefined) => {
    if (!task) return [];
    const source = find(snapshot, "message", task.sourceMessageId);
    return [text(task.accountableThreadId), text(source?.fromThread)].filter(Boolean);
  };
  if (kind === "task") return forTask(row);
  if (kind === "taskResult" || kind === "deliverable" || kind === "usage")
    return forTask(find(snapshot, "task", row.taskId));
  if (kind === "message") return [text(row.fromThread)].filter(Boolean);
  if (kind === "settings" && text(row.key).startsWith("team.wait."))
    return [text(row.key).slice("team.wait.".length)];
  return [];
}

export function parseTaskAction(value: unknown): TaskActionInput {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const need = (field: string) => {
    const found = input[field];
    if (typeof found !== "string" || !found.trim()) throw new Error(`${field} is required.`);
    return found;
  };
  const revision = () => {
    if (!Number.isInteger(input.revision) || Number(input.revision) < 1)
      throw new Error("revision is required.");
    return Number(input.revision);
  };
  if (input.action === "stop") return { action: "stop", taskId: need("taskId") };
  if (input.action === "accept")
    return { action: "accept", taskId: need("taskId"), revision: revision() };
  if (input.action === "send_back")
    return {
      action: "send_back",
      taskId: need("taskId"),
      revision: revision(),
      feedback: need("feedback").trim().slice(0, 4000),
    };
  if (input.action === "wake_now")
    return { action: "wake_now", threadId: need("threadId"), waitId: need("waitId") };
  throw new Error("Unknown task action.");
}

/** Sends a task action to the daemon. Command ids repeat for a repeated click, so it runs once. */
export async function runTaskAction(
  call: (method: string, params: unknown, commandId?: string) => Promise<unknown>,
  input: TaskActionInput,
): Promise<void> {
  if (input.action === "stop")
    await call("task.cancel", { id: input.taskId, confirmed: true }, `shell:stop:${input.taskId}`);
  else if (input.action === "wake_now")
    await call(
      "company.wakeNow",
      { threadId: input.threadId, waitId: input.waitId },
      `shell:wake:${input.waitId}`,
    );
  else
    await call(
      "task.review",
      {
        id: input.taskId,
        revision: input.revision,
        decision: input.action === "accept" ? "accept" : "changes",
        ...(input.action === "send_back" ? { feedback: input.feedback } : {}),
        confirmed: true,
      },
      `shell:${input.action}:${input.taskId}:${input.revision}`,
    );
}
