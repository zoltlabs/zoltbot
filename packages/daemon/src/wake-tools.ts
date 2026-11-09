import { createHash } from "node:crypto";
import { saveWake } from "@zoltbot/core";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import { parse, type WakeInput, WakeInputSchema } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api.js";

export const wakeToolDefinition = {
  name: "chat_wake",
  description:
    "Propose a one-time Wake when condition for this chat. List exact task, turn and background-job ids first; never guess ambiguous tests. A visible card waits for the person to save it. Does not stop current work. Topic waits resurface only. Fallback must be a future ISO timestamp. No new permissions are granted.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: ["list", "prepare"] },
      key: { type: "string", minLength: 1, maxLength: 100 },
      input: { ...WakeInputSchema, properties: { ...WakeInputSchema.properties } },
    },
    required: ["action"],
    additionalProperties: false,
  },
};
export function wakeTools(context: RuntimeContext) {
  return async (call: ToolInvocation) => {
    const args = call.arguments as { action: string; key?: string; input?: WakeInput };
    const thread = context.store.record("thread", call.actor.threadId);
    if (!thread || thread.archived || thread.fork) throw new Error("thread_unavailable");
    if (args.action === "list") {
      const state = context.store.snapshot(),
        projectId = thread.projectId;
      const threads = (state.thread ?? []).filter((t) => !t.archived && t.projectId === projectId);
      const ids = new Set(threads.map((t) => t.id));
      const result = {
        contract: {
          action: "prepare",
          key: "stable retry key",
          input: {
            threadId: thread.id,
            fallbackAt: "future ISO timestamp",
            behavior: "inbox|resume",
            continuation: "next step; required for resume",
            conditions: [
              "{kind:job,sessionId,jobId,outcome:finished|passed}",
              "{kind:task,taskId,outcome:finished|passed}",
              "{kind:turn,turnId,outcome:finished|passed}",
              "{kind:pr,repository:owner/repo,number}",
              "{kind:ci,repository:owner/repo,runId,attempt,outcome:finished|passed}",
              "{kind:topic,projectId,phrase}; inbox only",
            ],
            note: "input.condition is one of the listed condition objects",
          },
        },
        threadId: thread.id,
        projectId,
        chats: threads.slice(0, 30).map((t) => ({ id: t.id, title: t.title })),
        tasks: (state.task ?? [])
          .filter((t) => ids.has(t.threadId))
          .slice(-30)
          .map((t) => ({ id: t.id, title: t.title, state: t.state })),
        turns: (state.turn ?? [])
          .filter((t) => ids.has(t.threadId))
          .slice(-30)
          .map((t) => ({ id: t.id, threadId: t.threadId, status: t.status })),
        jobs: (state.session ?? [])
          .filter((s) => ids.has(s.threadId))
          .flatMap((s) =>
            ((s.background ?? []) as { id: string; description: string; state: string }[]).map(
              (j) => ({ sessionId: s.id, jobId: j.id, description: j.description, state: j.state }),
            ),
          )
          .slice(-30),
        more: false,
      };
      while (JSON.stringify(result).length > 3600) {
        const lists = [result.chats, result.tasks, result.turns, result.jobs].sort(
          (a, b) => b.length - a.length,
        );
        if (!lists[0]?.length) break;
        lists[0].pop();
        result.more = true;
      }
      return result;
    }
    if (args.action !== "prepare" || !args.key) throw new Error("wake_key_required");
    const input = parse(WakeInputSchema, { ...args.input, threadId: thread.id });
    const check = await context.privacy.prepareData(input);
    const id = `wake:${createHash("sha256").update(`${thread.id}:${args.key}`).digest("hex").slice(0, 24)}`;
    const commandId = `wake:propose:${id}`,
      before = context.store.lastSeq();
    const result = context.store.dispatch(commandId, (state) => {
      check(state);
      return saveWake(
        state,
        input,
        id,
        {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "agent", id: call.actor.agentId },
        },
        undefined,
        true,
      );
    });
    context.publish(context.store.eventsSince(before));
    return {
      proposal: result.result,
      next: "The person can review and save the Wake when card in this chat.",
    };
  };
}
