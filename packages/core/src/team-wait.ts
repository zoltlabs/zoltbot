import {
  type DomainEvent,
  parse,
  parseEvent,
  type TeamWait,
  TeamWaitSchema,
  teamWaitKey,
} from "@zoltbot/protocol";
import type { CommandContext, Outcome } from "./commands.js";
import { queueSystemNotice } from "./input-queue.js";
import type { DomainState } from "./projectors.js";
import { managerCanRead, type TeamActor } from "./team.js";

/** Task states that end a wait: the result is back for review, or the task stopped. */
export const teamWaitDoneStates = ["review", "completed", "failed", "cancelled"];
export const teamWaitLimits = { targets: 20, defaultMinutes: 120, maxMinutes: 7 * 24 * 60 };

export function readTeamWait(state: DomainState, threadId: string): TeamWait | undefined {
  const row = state.settings?.find((r) => r.key === teamWaitKey(threadId));
  try {
    return row ? parse(TeamWaitSchema, row.value) : undefined;
  } catch {
    return undefined;
  }
}
export interface TeamWaitTarget {
  kind: "task" | "chat";
  id: string;
  title: string;
  state: string;
  done: boolean;
}
const busyInput = (state: DomainState, threadId: string) =>
  (state.item ?? []).some(
    (i) =>
      i.threadId === threadId &&
      i.kind === "user" &&
      ["queued", "sending", "uncertain"].includes(
        String((i.body as { queueState?: unknown })?.queueState),
      ),
  );
/** Each target's current state. A chat is done when it has no running turn and nothing queued. */
export function teamWaitTargets(
  state: DomainState,
  wait: Pick<TeamWait, "taskIds" | "chatIds">,
): TeamWaitTarget[] {
  const tasks = wait.taskIds.map((id) => {
    const task = state.task?.find((r) => r.id === id);
    const taskState = String(task?.state ?? "cancelled");
    return {
      kind: "task" as const,
      id,
      title: String(task?.title ?? id),
      state: taskState,
      done: teamWaitDoneStates.includes(taskState),
    };
  });
  const chats = wait.chatIds.map((id) => {
    const thread = state.thread?.find((r) => r.id === id);
    const running =
      !thread?.archived &&
      ((state.turn ?? []).some((t) => t.threadId === id && t.status === "running") ||
        busyInput(state, id));
    return {
      kind: "chat" as const,
      id,
      title: String(thread?.title ?? id),
      state: running ? "running" : "idle",
      done: !running,
    };
  });
  return [...tasks, ...chats];
}
/** A chat may wait on tasks it assigned or is accountable for, and on chats it manages. */
function waitable(state: DomainState, threadId: string, kind: "task" | "chat", id: string) {
  if (kind === "task") {
    const task = state.task?.find((r) => r.id === id);
    if (!task || task.threadId === threadId) return false;
    if (task.accountableThreadId === threadId) return true;
    const source = state.message?.find((r) => r.id === task.sourceMessageId);
    return source?.fromThread === threadId;
  }
  if (id === threadId) return false;
  return (
    managerCanRead(state, threadId, id) ||
    (state.task ?? []).some(
      (r) =>
        r.threadId === id &&
        r.accountableThreadId === threadId &&
        !["completed", "cancelled"].includes(String(r.state)),
    )
  );
}
function settingsEvent(
  state: DomainState,
  wait: TeamWait,
  context: CommandContext,
  index: number,
): DomainEvent {
  const key = teamWaitKey(wait.threadId);
  const exists = state.settings?.some((r) => r.key === key);
  return parseEvent({
    eventId: `${context.commandId}:${index}`,
    commandId: context.commandId,
    aggregateType: "settings",
    aggregateId: key,
    type: exists ? "settings.updated" : "settings.created",
    occurredAt: context.at,
    payload: { key, value: parse(TeamWaitSchema, wait) },
  });
}
export interface TeamWaitInput {
  taskIds?: string[];
  chatIds?: string[];
  note?: string;
  fallbackMinutes?: number;
}
/**
 * An agent's chat starts waiting on its own delegated work. Anything outside that scope is
 * refused, so it can't be used to watch other chats without the owner's Wake when card. A wait
 * whose targets have all finished is not saved; the result says so instead.
 */
export function startTeamWait(
  state: DomainState,
  actor: TeamActor,
  input: TeamWaitInput,
  id: string,
  context: CommandContext,
): Outcome {
  const thread = state.thread?.find((r) => r.id === actor.threadId && !r.archived);
  if (
    !thread ||
    thread.agentId !== actor.agentId ||
    context.actor.kind !== "agent" ||
    context.actor.id !== actor.agentId
  )
    throw new Error("active_turn_required");
  const taskIds = [...new Set(input.taskIds ?? [])];
  const chatIds = [...new Set(input.chatIds ?? [])];
  if (!taskIds.length && !chatIds.length) throw new Error("wait_target_required");
  if (taskIds.length + chatIds.length > teamWaitLimits.targets)
    throw new Error("too_many_wait_targets");
  const outside = [
    ...taskIds.filter((t) => !waitable(state, thread.id as string, "task", t)),
    ...chatIds.filter((c) => !waitable(state, thread.id as string, "chat", c)),
  ];
  if (outside.length) throw new Error(`wait_outside_scope: ${outside.slice(0, 5).join(", ")}`);
  const minutes = Math.min(
    Math.max(1, Math.round(input.fallbackMinutes ?? teamWaitLimits.defaultMinutes)),
    teamWaitLimits.maxMinutes,
  );
  const targets = teamWaitTargets(state, { taskIds, chatIds });
  if (targets.every((t) => t.done)) return { events: [], result: { status: "finished", targets } };
  const previous = readTeamWait(state, thread.id as string);
  if (previous?.id === id && previous.status === "waiting")
    return { events: [], result: { status: "waiting", wait: previous, targets } };
  const wait: TeamWait = {
    id,
    threadId: thread.id as string,
    taskIds,
    chatIds,
    ...(input.note?.trim() ? { note: input.note.trim().slice(0, 1000) } : {}),
    status: "waiting",
    revision: (previous?.revision ?? 0) + 1,
    fallbackAt: new Date(Date.parse(context.at) + minutes * 60_000).toISOString(),
    createdAt: context.at,
    updatedAt: context.at,
  };
  return {
    events: [settingsEvent(state, wait, context, 0)],
    result: { status: "waiting", wait, targets, replaced: previous?.status === "waiting" },
  };
}
const reasonText = {
  finished: "Everything you waited for has finished.",
  fallback: "The fallback time passed before everything finished.",
  owner: "The owner woke you before everything finished.",
};
/**
 * Ends a wait and queues one notice that wakes its chat. Calling it again for the same wait does
 * nothing, so a restart or a repeated Wake now can't wake the chat twice.
 */
export function wakeTeamWait(
  state: DomainState,
  threadId: string,
  waitId: string,
  reason: "finished" | "fallback" | "owner",
  context: CommandContext,
): Outcome {
  const wait = readTeamWait(state, threadId);
  if (!wait || wait.id !== waitId) throw new Error("wait_not_found");
  if (wait.status !== "waiting") return { events: [], result: { wait, woken: false } };
  if (reason === "owner" && context.actor.kind !== "human") throw new Error("human_input_required");
  const thread = state.thread?.find((r) => r.id === threadId);
  const next: TeamWait = {
    ...wait,
    status: thread && !thread.archived ? "woken" : "cancelled",
    reason,
    revision: wait.revision + 1,
    updatedAt: context.at,
  };
  const events = [settingsEvent(state, next, context, 0)];
  if (next.status === "woken") {
    const lines = teamWaitTargets(state, wait).map(
      (t) => `- ${t.kind === "task" ? "Task" : "Chat"} ${t.id} "${t.title}": ${t.state}`,
    );
    const queued = queueSystemNotice(
      state,
      {
        threadId,
        text: [
          `[Team wait] ${reasonText[reason]}`,
          ...lines,
          ...(wait.note ? [`Your note: ${wait.note}`] : []),
          "Read team_read_thread or company_work for results. A submitted result still needs acceptance.",
        ].join("\n"),
        notice: { kind: "wait", waitId, state: reason },
      },
      `company:signal:wait:${wait.id}:${wait.revision}:input`,
      { ...context, actor: { kind: "system", id: "team-wait" } },
    );
    events.push(
      ...queued.events.map((event, index) => ({
        ...event,
        eventId: `${context.commandId}:${index + 1}`,
      })),
    );
  }
  return { events, result: { wait: next, woken: next.status === "woken" } };
}

export interface TeamRequest {
  messageId: string;
  type: "assignment" | "question" | "update" | "reply" | "report";
  to: { id: string; title: string };
  sentAt: string;
  text: string;
  status: "open" | "answered" | "done";
  taskId?: string;
  taskState?: string;
  replies: number;
  lastReply?: string;
}
/** The words a teammate wrote, without the routing line the daemon puts above them. */
export const messageWords = (row: { body?: unknown }) => {
  const text = ((row.body as { type?: string; text?: string }[] | undefined) ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
  return text.startsWith("[") && text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text;
};
/** Messages and assignments a chat sent, newest first, with whether each is still open. */
export function teamRequests(
  state: DomainState,
  threadId: string,
  options: { open?: boolean; limit?: number } = {},
): TeamRequest[] {
  const sent = (state.message ?? [])
    .filter((m) => m.fromThread === threadId && m.kind !== "control")
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const rows: TeamRequest[] = [];
  for (const m of sent) {
    const replies = (state.message ?? [])
      .filter((r) => r.replyTo === m.id)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const task =
      m.kind === "task" ? state.task?.find((t) => t.sourceMessageId === m.id) : undefined;
    const type: TeamRequest["type"] =
      m.kind === "task"
        ? "assignment"
        : m.kind === "result"
          ? m.replyTo
            ? "reply"
            : "report"
          : m.expectsReply
            ? "question"
            : "update";
    const taskState = task ? String(task.state) : undefined;
    const status: TeamRequest["status"] =
      type === "assignment"
        ? ["completed", "failed", "cancelled"].includes(taskState ?? "cancelled")
          ? "done"
          : taskState === "review" || replies.length
            ? "answered"
            : "open"
        : type === "question"
          ? replies.length
            ? "answered"
            : "open"
          : "done";
    if (options.open && status === "done") continue;
    const target = state.thread?.find((t) => t.id === m.thread);
    const last = replies.at(-1);
    rows.push({
      messageId: String(m.id),
      type,
      to: { id: String(m.thread ?? ""), title: String(target?.title ?? "") },
      sentAt: String(m.createdAt),
      text: messageWords(m).slice(0, 200),
      status,
      ...(task ? { taskId: String(task.id), taskState: String(task.state) } : {}),
      replies: replies.length,
      ...(last ? { lastReply: messageWords(last).slice(0, 200) } : {}),
    });
    if (rows.length >= Math.min(Math.max(1, options.limit ?? 20), 50)) break;
  }
  return rows;
}
