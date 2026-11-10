import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  briefTeam,
  type DomainState,
  managerAbove,
  managerCanRead,
  messageTeam,
  type Outcome,
  reportUp,
  type TeamMessageInput,
  workspaceChats,
} from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "./api.js";
import { sendToChief } from "./chief/inbox.js";
import { refreshTaint } from "./knowledge-taint.js";

export const teamToolDefinitions = [
  {
    name: "team_delegate",
    description:
      "Assign tracked work in your scope. Brief a new chat (title, optional profileId and teamId of a team below you) or an existing chat or manager below you (chatId). Brief up to 2000 characters, stable key for retries. Returns a linked bounded result or progress.",
    inputSchema: {
      type: "object" as const,
      properties: {
        planId: { type: "string", maxLength: 200 },
        budgetUsd: { type: "number", minimum: 0 },
        key: { type: "string", minLength: 1, maxLength: 100 },
        brief: { type: "string", minLength: 1, maxLength: 2000 },
        title: { type: "string", minLength: 1, maxLength: 150 },
        profileId: { type: "string", maxLength: 256 },
        teamId: { type: "string", maxLength: 256 },
        chatId: { type: "string", maxLength: 256 },
      },
      required: ["key", "brief"],
      additionalProperties: false,
    },
  },
  {
    name: "team_report",
    description:
      "Send a result, update or question to the nearest manager above you. Up to 2000 characters, stable key. If you have no manager, ask the human instead. Optional learned: up to 5 durable {kind,title,body,evidence} entries, written like team_write_knowledge.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", minLength: 1, maxLength: 100 },
        text: { type: "string", minLength: 1, maxLength: 2000 },
        // Entries are validated by the knowledge write policy, so the hint stays small (I9).
        learned: { type: "array", maxItems: 5, items: { type: "object" } },
      },
      required: ["key", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "team_message",
    description:
      'Message a chat in your workspace. question: true wakes it for a reply; otherwise it reads the update next turn. to: chat id or exact title, else your nearest manager; "chief" reaches the user\'s main agent, and idea: true marks an idea worth doing outside your brief. replyTo answers a message you got. Stable key.',
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", minLength: 1, maxLength: 100 },
        text: { type: "string", minLength: 1, maxLength: 2000 },
        to: { type: "string", minLength: 1, maxLength: 256 },
        question: { type: "boolean" },
        idea: { type: "boolean" },
        replyTo: { type: "string", minLength: 1, maxLength: 256 },
        learned: { type: "array", maxItems: 5, items: { type: "object" } },
      },
      required: ["key", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "team_read_thread",
    description:
      "Managers only. Read status and up to 2000 characters of recent output from any chat below you.",
    inputSchema: {
      type: "object" as const,
      properties: { childId: { type: "string", minLength: 1, maxLength: 256 } },
      required: ["childId"],
      additionalProperties: false,
    },
  },
];
export const teamToolNames = new Set(teamToolDefinitions.map((tool) => tool.name));
/** Kept so sessions frozen before `team_message` still validate and run their `team_report`. */
export const legacyTeamToolDefinitions = teamToolDefinitions.filter(
  (t) => t.name === "team_report",
);
/** New sessions get `team_message`, which covers reporting, in place of `team_report`. */
export const currentTeamToolDefinitions = teamToolDefinitions.filter(
  (t) => t.name !== "team_report",
);
/** Refusals the model can act on, returned as results rather than a generic tool failure. */
const messageRefusals = new Set([
  "chat_unavailable",
  "chat_outside_workspace",
  "no_manager_above",
  "reply_not_found",
  "reply_target_unavailable",
  "reply_target_mismatch",
  "hop_limit_reached",
  "rate_limited",
]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const busy = (status: string) => ["queued", "running"].includes(status);

export function teamTools(context: RuntimeContext, options: { waitMs?: number } = {}) {
  function authorize(actor: ToolActor, name: string, args: unknown): boolean {
    const state = context.store.snapshot(["thread", "project", "subproject"]);
    const self = state.thread?.find((row) => row.id === actor.threadId && !row.archived);
    if (!self) return false;
    if (name === "team_report") return !!managerAbove(state, actor.threadId);
    if (name === "team_message") return !!self.projectId;
    if (!self.node) return false;
    if (name === "team_delegate") return true;
    const childId = String((args as { childId?: unknown })?.childId ?? "");
    return (
      name === "team_read_thread" &&
      (managerCanRead(state, actor.threadId, childId) ||
        context.store
          .snapshot(["task"])
          .task?.some((r) => r.threadId === childId && r.accountableThreadId === actor.threadId) ===
          true)
    );
  }
  function read(actor: ToolActor, childId: string) {
    if (!authorize(actor, "team_read_thread", { childId })) throw new Error("grant_required");
    const state = context.store.snapshot(["thread", "turn", "item", "task"]);
    const turns =
      state.turn
        ?.filter((row) => row.threadId === childId)
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))) ?? [];
    const queued = state.item?.some(
      (row) =>
        row.threadId === childId &&
        row.kind === "user" &&
        (row.body as { queueState?: unknown })?.queueState === "queued",
    );
    const status =
      turns[0]?.status === "running"
        ? "running"
        : queued || !turns[0]
          ? "queued"
          : String(turns[0].status);
    const text = (state.item ?? [])
      .filter((row) => row.threadId === childId && row.kind === "message")
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .map((row) => {
        const body = row.body as { text?: unknown };
        return typeof body.text === "string" ? body.text : "";
      })
      .join("\n")
      .slice(-2000);
    const task = state.task?.find(
      (r) =>
        r.threadId === childId && !["completed", "cancelled", "failed"].includes(String(r.state)),
    );
    const result = {
      ...(task ? { taskId: task.id } : {}),
      childId,
      link: `#chat/${encodeURIComponent(childId)}`,
      status,
      summary: text,
    };
    while (JSON.stringify(result).length > 3500)
      result.summary = result.summary.slice(Math.floor(result.summary.length / 2));
    return result;
  }
  async function dispatch(
    commandId: string,
    value: unknown,
    run: (state: DomainState) => Outcome,
  ): Promise<Record<string, unknown>> {
    const check = await context.privacy.prepareData(value);
    const before = context.store.lastSeq();
    let produced = false;
    const receipt = context.store.dispatch(commandId, (state) => {
      check(state);
      produced = true;
      return run(state);
    });
    if (produced) context.publish(context.store.eventsSince(before));
    return (receipt.result ?? {}) as Record<string, unknown>;
  }
  async function delegate(call: ToolInvocation) {
    const args = call.arguments as {
      key: string;
      brief: string;
      title?: string;
      profileId?: string;
      teamId?: string;
      chatId?: string;
      planId?: string;
      budgetUsd?: number;
    };
    if (!authorize(call.actor, "team_delegate", args)) throw new Error("grant_required");
    if (!args.chatId && !args.title) throw new Error("title_or_chat_required");
    const id = hash(JSON.stringify([call.actor.threadId, args.key]));
    // Keep the original child id scheme so retries of earlier delegations still resolve.
    const childId = `child-${id}`;
    const messageId = args.chatId ? `brief-${id}` : `${childId}:brief`;
    const commandId = `delegate:${args.chatId ? messageId : childId}`;
    const input = {
      ...(args.planId ? { planId: args.planId } : {}),
      ...(args.budgetUsd !== undefined ? { budgetUsd: args.budgetUsd } : {}),
      brief: args.brief,
      ...(args.chatId
        ? { chatId: args.chatId }
        : {
            title: args.title as string,
            profileId: args.profileId ?? call.actor.agentId,
            ...(args.teamId ? { teamId: args.teamId } : {}),
          }),
    };
    const result = await dispatch(commandId, input, (state) =>
      briefTeam(
        state,
        call.actor,
        input,
        { childId, messageId },
        {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "agent", id: call.actor.agentId },
        },
      ),
    );
    const target = result;
    if (target.managerThreadId !== call.actor.threadId || target.brief !== args.brief)
      throw new Error("command_receipt_conflict");
    if (args.chatId && target.childId !== args.chatId) throw new Error("command_receipt_conflict");
    const targetId = String(target.childId);
    if (!busy(read(call.actor, targetId).status)) return read(call.actor, targetId);
    // The task runner dispatches the assignment; waking here would race task input creation.
    const deadline = Date.now() + (options.waitMs ?? 0);
    for (;;) {
      const progress = read(call.actor, targetId);
      if (!busy(progress.status) || Date.now() >= deadline) return progress;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  async function report(call: ToolInvocation) {
    const args = call.arguments as { key: string; text: string };
    if (!authorize(call.actor, "team_report", args)) throw new Error("no_manager_above");
    const messageId = `report-${hash(JSON.stringify([call.actor.threadId, args.key]))}`;
    const commandId = `report:${messageId}`;
    const result = await dispatch(commandId, { text: args.text }, (state) =>
      reportUp(state, call.actor, { text: args.text }, messageId, {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "agent", id: call.actor.agentId },
      }),
    );
    if (!isDeepStrictEqual(result.text, args.text)) throw new Error("command_receipt_conflict");
    const managerThreadId = String(result.managerThreadId);
    try {
      await context.wake(managerThreadId);
      return { delivered: "queued", managerThreadId };
    } catch {
      return { delivered: "queued_not_woken", managerThreadId };
    }
  }
  async function message(call: ToolInvocation) {
    const args = call.arguments as Omit<TeamMessageInput, "kind"> & {
      key: string;
      question?: boolean;
      idea?: boolean;
    };
    if (!authorize(call.actor, "team_message", args)) throw new Error("grant_required");
    // Injected text must not be able to wake another chat with a request.
    if (args.question && refreshTaint(context.store, call.actor.sessionId))
      return {
        error: "question_not_allowed",
        why: "This chat read content Zoltbot cannot vouch for. Send an update instead.",
      };
    // Zolt sits above every workspace; it keeps what leads send and decides what reaches the user.
    if (args.to?.trim().toLowerCase() === "chief" && !args.replyTo)
      return sendToChief(context, call.actor, {
        key: args.key,
        text: args.text,
        kind: args.idea ? "idea" : args.question ? "question" : "update",
      });
    let to: string | undefined;
    if (args.to && !args.replyTo) {
      const state = context.store.snapshot(["thread", "agent", "project", "subproject"]);
      const found = workspaceChats(state, call.actor.threadId, args.to);
      // An unknown name is how a chat discovers others: list partial matches first, nearest first.
      if (found.length !== 1) {
        const all = workspaceChats(state, call.actor.threadId);
        const words = args.to.toLowerCase().split(/\s+/).filter(Boolean);
        const near = all.filter((row) => words.some((w) => row.title.toLowerCase().includes(w)));
        return {
          error: found.length ? "chat_ambiguous" : "chat_not_found",
          chats: (found.length
            ? found
            : [...near, ...all.filter((row) => !near.includes(row))]
          ).slice(0, 12),
          total: all.length,
        };
      }
      to = found[0]?.id;
    }
    const input: TeamMessageInput = {
      text: args.text,
      ...(to ? { to } : {}),
      kind: args.question ? "question" : "update",
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    };
    const messageId = `msg-${hash(JSON.stringify([call.actor.threadId, args.key]))}`;
    const commandId = `message:${messageId}`;
    let result: Record<string, unknown>;
    try {
      result = await dispatch(commandId, input, (state) =>
        messageTeam(state, call.actor, input, messageId, {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "agent", id: call.actor.agentId },
        }),
      );
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (messageRefusals.has(code)) return { error: code };
      throw error;
    }
    if (result.text !== args.text || (to && result.to !== to))
      throw new Error("command_receipt_conflict");
    const target = String(result.to);
    if (!result.wake) return { messageId, to: target, delivered: "queued" };
    try {
      await context.wake(target);
      return { messageId, to: target, delivered: "queued" };
    } catch {
      return { messageId, to: target, delivered: "queued_not_woken" };
    }
  }
  return {
    authorize,
    tools: new Map<string, (call: ToolInvocation) => Promise<unknown>>([
      ["team_delegate", delegate],
      ["team_report", report],
      ["team_message", message],
      [
        "team_read_thread",
        async ({ actor, arguments: args }) =>
          read(actor, String((args as { childId: string }).childId)),
      ],
    ]),
  };
}
