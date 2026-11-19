import { createHash } from "node:crypto";
import { startTeamWait, type TeamWaitInput, teamRequests } from "@zoltbot/core";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import type { RuntimeContext } from "./api.js";

export const teamWaitToolDefinitions = [
  {
    name: "team_requests",
    description:
      "List messages and assignments this chat sent, newest first, with status open, answered or done. open: true hides done ones.",
    inputSchema: {
      type: "object" as const,
      properties: {
        open: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "team_wait",
    description:
      "Wait until tasks you delegated (taskIds) or turns in chats you manage (chatIds) finish, then wake with their states. No approval needed. For anything else use chat_wake. Stable key; note is your next step; fallbackMinutes default 120.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: { type: "string", minLength: 1, maxLength: 100 },
        taskIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 256 } },
        chatIds: { type: "array", maxItems: 20, items: { type: "string", maxLength: 256 } },
        note: { type: "string", maxLength: 1000 },
        fallbackMinutes: { type: "integer", minimum: 1, maximum: 10080 },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
];
export const teamWaitToolNames = new Set(teamWaitToolDefinitions.map((tool) => tool.name));
/** Refusals the model can act on, returned as results rather than a generic tool failure. */
const refusals = ["wait_target_required", "too_many_wait_targets", "wait_outside_scope"];

export function teamWaitTools(context: RuntimeContext) {
  function authorize(actor: ToolActor) {
    const thread = context.store.record("thread", actor.threadId);
    return !!thread && !thread.archived && !thread.fork && !!thread.projectId;
  }
  async function requests(call: ToolInvocation) {
    const args = call.arguments as { open?: boolean; limit?: number };
    const state = context.store.snapshot(["message", "task", "thread"]);
    const rows = teamRequests(state, call.actor.threadId, args);
    return { requests: rows, more: rows.length >= (args.limit ?? 20) };
  }
  async function wait(call: ToolInvocation) {
    const { key, ...input } = call.arguments as TeamWaitInput & { key: string };
    const id = `team-wait-${createHash("sha256")
      .update(JSON.stringify([call.actor.threadId, key]))
      .digest("hex")
      .slice(0, 24)}`;
    const commandId = `team-wait:start:${id}`;
    const check = await context.privacy.prepareData(input);
    const before = context.store.lastSeq();
    try {
      const receipt = context.store.dispatch(commandId, (state) => {
        check(state);
        return startTeamWait(state, call.actor, input, id, {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "agent", id: call.actor.agentId },
        });
      });
      context.publish(context.store.eventsSince(before));
      const result = receipt.result as { status: string; targets: unknown[] };
      return {
        ...result,
        next:
          result.status === "finished"
            ? "Everything already finished. Read the results now."
            : "End your turn. You will be woken when these finish or at the fallback time.",
      };
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      const known = refusals.find((r) => code.startsWith(r));
      if (!known) throw error;
      return {
        error: known,
        ...(known === "wait_outside_scope"
          ? {
              why: `Not your delegated work: ${code.slice(known.length + 2)}. Use chat_wake, which the owner reviews.`,
            }
          : {}),
      };
    }
  }
  return {
    authorize,
    tools: new Map<string, (call: ToolInvocation) => Promise<unknown>>([
      ["team_requests", requests],
      ["team_wait", wait],
    ]),
  };
}
