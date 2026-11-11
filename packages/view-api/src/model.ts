import { compareSessions, type Interaction, parse, threadFacts } from "@zoltbot/protocol";
import {
  type Chat,
  type Check,
  type Request,
  type TopicValues,
  topicSchemas,
  type Usage,
  type Workspace,
} from "./topics.js";

type Row = Record<string, unknown>;
export type ViewSnapshot = { entities: Record<string, Row[] | undefined> };
const text = (value: unknown) => (typeof value === "string" ? value : "");
const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);
const amount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const newest = (values: Row[], field: string) =>
  [...values].sort(
    (a, b) => text(b[field]).localeCompare(text(a[field])) || text(b.id).localeCompare(text(a.id)),
  )[0];
const widening = new Set(["allow_session", "allow_accept_edits", "allow_rule", "reject_rule"]);
const choiceLabels: Record<string, string> = {
  allow_once: "Allow once",
  reject_once: "Reject once",
  allow_session: "Allow for this session",
  allow_accept_edits: "Allow edits for this session",
  allow_rule: "Always allow",
  reject_rule: "Always reject",
};

export function mapRequests({ entities: state }: ViewSnapshot): Request[] {
  return (state.interaction ?? [])
    .filter((row) => row.state === "pending")
    .sort(
      (a, b) =>
        text(a.createdAt).localeCompare(text(b.createdAt)) || text(a.id).localeCompare(text(b.id)),
    )
    .map((row) => {
      const request = row as unknown as Interaction;
      const choices = new Map<string, Request["choices"][number]>();
      for (const item of request.items)
        for (const choice of item.choices ?? [])
          choices.set(choice.id, {
            id: choice.id,
            label:
              "label" in choice && choice.label
                ? choice.label
                : (choiceLabels[choice.id] ?? choice.id),
            widens: widening.has(choice.id),
          });
      if (request.type === "plan" || request.type === "gate") {
        choices.set("accept", { id: "accept", label: "Accept", widens: false });
        choices.set("decline", { id: "decline", label: "Decline", widens: false });
      }
      // A secret question stays in the host's private-input flow.
      const questions = request.items
        .filter((item) => !item.secret)
        .map((item) => ({
          id: item.id,
          label: item.prompt,
          ...(item.options
            ? { options: item.options.map(({ id, label }) => ({ id, label })) }
            : {}),
          freeText: item.allowOther !== false,
          ...(item.multi !== undefined ? { multi: item.multi } : {}),
          ...(item.schema !== undefined ? { schema: item.schema } : {}),
        }));
      const context = request.context;
      return {
        id: request.id,
        version: request.version,
        chatId: request.threadId,
        type: request.type,
        title: request.title ?? request.items[0]?.prompt ?? "Request",
        urgency: request.urgency,
        createdAt: request.createdAt,
        ...(context
          ? {
              context: {
                ...(context.markdown !== undefined ? { markdown: context.markdown } : {}),
                ...(context.toolName !== undefined ? { tool: context.toolName } : {}),
                ...(context.command !== undefined ? { command: context.command } : {}),
              },
            }
          : {}),
        choices: [...choices.values()],
        ...(request.type === "question" || request.type === "form" ? { questions } : {}),
      };
    });
}
function sumUsage(records: Row[]) {
  const known = records.every((row) => row.costKnown === true && typeof row.costUsd === "number");
  return {
    inputTokens: records.reduce((sum, row) => sum + amount(row.inputTokens), 0),
    outputTokens: records.reduce((sum, row) => sum + amount(row.outputTokens), 0),
    ...(known ? { costUsd: records.reduce((sum, row) => sum + amount(row.costUsd), 0) } : {}),
  };
}
function activity(state: ViewSnapshot["entities"], threadId: string) {
  const running = new Set(
    (state.turn ?? [])
      .filter((row) => row.threadId === threadId && row.status === "running")
      .map((row) => row.id),
  );
  const items = (state.item ?? [])
    .filter((row) => row.threadId === threadId && running.has(row.turnId))
    .sort((a, b) => Number(b.seq) - Number(a.seq));
  for (const item of items) {
    const body = object(item.body);
    if (item.kind === "tool" && body.status === "running" && text(body.title))
      return text(body.title);
    if (item.kind === "plan") {
      const step = rows(body.entries).find((entry) => entry.status === "in_progress");
      if (text(step?.step)) return text(step?.step);
    }
  }
  return undefined;
}
export function mapChats(snapshot: ViewSnapshot, now = new Date()): Chat[] {
  const state = snapshot.entities,
    facts = threadFacts(state),
    requests = mapRequests(snapshot);
  return (state.thread ?? []).map((thread) => {
    const id = text(thread.id),
      profile = state.agent?.find((row) => row.id === thread.agentId);
    const session = [...(state.session ?? [])]
      .filter((row) => row.threadId === id)
      .sort(compareSessions)[0];
    const definition = state.agentDefinition?.find((row) => row.id === profile?.definitionId);
    const turn = newest(
      (state.turn ?? []).filter((row) => row.threadId === id),
      "startedAt",
    );
    const workspace = state.workspace?.find((row) => row.id === session?.workspaceId);
    const task = state.task?.find((row) => row.id === thread.taskId);
    const parentTask = state.task?.find((row) => row.id === task?.parentId);
    const parent = text(parentTask?.threadId);
    const sessions = new Set(
      (state.session ?? []).filter((row) => row.threadId === id).map((row) => row.id),
    );
    const problem = object(session?.runtimeStatus),
      active = activity(state, id);
    const projectId =
      text(thread.projectId) ||
      text(
        object(thread.node).type === "project"
          ? object(thread.node).id
          : state.subproject?.find((row) => row.id === object(thread.node).id)?.projectId,
      );
    return {
      id,
      title: text(thread.title),
      kind: thread.kind as Chat["kind"],
      status: facts.mailbox(thread, now) ?? "idle",
      ...(text(problem.state)
        ? {
            problem: {
              kind: problem.state as NonNullable<Chat["problem"]>["kind"],
              ...(typeof problem.detail === "string" ? { detail: problem.detail } : {}),
            },
          }
        : {}),
      ...(turn
        ? {
            lastTurn: {
              status: turn.status as NonNullable<Chat["lastTurn"]>["status"],
              ...(typeof turn.endedAt === "string" ? { endedAt: turn.endedAt } : {}),
            },
          }
        : {}),
      ...(active ? { activity: active } : {}),
      profile: {
        id: text(profile?.id) || text(thread.agentId),
        name: text(profile?.name) || "Profile",
      },
      provider: {
        id: text(definition?.id) || text(session?.provider) || "unknown",
        name: text(definition?.displayName) || text(session?.provider) || "Unknown",
      },
      ...(projectId ? { workspaceId: projectId } : {}),
      ...(workspace
        ? {
            worktree: {
              id: text(workspace.id),
              kind: workspace.kind as "folder" | "worktree",
              ...(typeof workspace.branch === "string" ? { branch: workspace.branch } : {}),
              ...(typeof workspace.baseRef === "string" ? { baseRef: workspace.baseRef } : {}),
            },
          }
        : {}),
      ...(parent ? { parentChatId: parent } : {}),
      requestIds: requests.filter((request) => request.chatId === id).map((request) => request.id),
      startedAt: text(thread.createdAt),
      updatedAt: text(thread.lastActivityAt),
      usage: sumUsage((state.usage ?? []).filter((row) => sessions.has(row.sessionId))),
    };
  });
}
export function mapWorkspaces({ entities: state }: ViewSnapshot): Workspace[] {
  return (state.project ?? [])
    .filter((row) => !row.archived)
    .map((row) => ({
      id: text(row.id),
      name: text(row.name),
      roots: rows(row.roots).map((root) => ({
        label: text(root.label),
        isRepository: !!text(root.repoRoot),
      })),
    }));
}
export function mapUsage(snapshot: ViewSnapshot, now = new Date()): Usage {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const records = (snapshot.entities.usage ?? []).filter((row) => {
    const at = Date.parse(text(row.recordedAt));
    return at >= midnight.getTime() && at <= now.getTime();
  });
  const day = now.toISOString().slice(0, 10);
  const budget = object(
    snapshot.entities.settings?.find((row) => row.key === `budget.day.${day}`)?.value,
  );
  const totals = sumUsage(records);
  return {
    today: {
      ...totals,
      costUsd: records.reduce((sum, row) => sum + amount(row.costUsd), 0),
      costKnown: totals.costUsd !== undefined,
    },
    ...(typeof budget.usd === "number"
      ? { budget: { limitUsd: budget.usd, period: "day" as const } }
      : {}),
    activeChats: mapChats(snapshot, now).filter(
      (chat) => chat.status === "working" || chat.status === "needs_you",
    ).length,
  };
}
export function mapChecks({ entities: state }: ViewSnapshot): Check[] {
  const result: Check[] = [];
  for (const shipping of state.shipping ?? []) {
    const task = state.task?.find((row) => row.id === shipping.taskId);
    if (!text(task?.threadId)) continue;
    for (const check of rows(object(shipping.snapshot).checks)) {
      const raw = text(check.state).toUpperCase();
      const status = ["SUCCESS", "PASSING"].includes(raw)
        ? "passing"
        : ["FAILURE", "FAILING", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(raw)
          ? "failing"
          : ["SKIPPED", "NEUTRAL"].includes(raw)
            ? "skipped"
            : "pending";
      result.push({
        chatId: text(task?.threadId),
        name: text(check.name),
        state: status,
        required: check.required === true,
      });
    }
  }
  return result;
}
export function mapTopics(snapshot: ViewSnapshot, now = new Date()): TopicValues {
  return {
    chats: parse(topicSchemas.chats, mapChats(snapshot, now)),
    requests: parse(topicSchemas.requests, mapRequests(snapshot)),
    workspaces: mapWorkspaces(snapshot),
    usage: mapUsage(snapshot, now),
    checks: mapChecks(snapshot),
  };
}
