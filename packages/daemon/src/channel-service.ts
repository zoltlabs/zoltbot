import { createHash } from "node:crypto";
import {
  channelRequestAction,
  type DomainState,
  type Outcome,
  postOwnerToChannel,
  readChannel,
  settleChannelRequests,
  syncChannels,
} from "@zoltbot/core";
import { type ChannelRequestAction, channelMethods, parse } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api.js";

const owner = { kind: "human" as const, id: "local-owner" };
const system = { kind: "system" as const, id: "channels" };
const channelKinds = [
  "channel",
  "channelPost",
  "channelRequest",
  "project",
  "subproject",
  "thread",
  "agent",
  "task",
  "turn",
  "item",
  "message",
] as const;

/**
 * Keeps channels in step with the teams and requests in step with their tasks. Each change is
 * one command keyed by what it writes, so repeated ticks and restarts write it once.
 */
export function reconcileChannels(context: RuntimeContext, at: string) {
  const run = (
    name: string,
    build: (
      state: DomainState,
      context: { commandId: string; at: string; actor: typeof system },
    ) => Outcome,
  ) => {
    const state = context.store.snapshot([...channelKinds]);
    const preview = build(state, { commandId: `channels:${name}`, at, actor: system });
    if (!preview.events.length) return;
    const key = createHash("sha256")
      .update(JSON.stringify(preview.events.map((event) => event.payload)))
      .digest("hex")
      .slice(0, 32);
    const commandId = `channels:${name}:${key}`;
    if (context.store.receipt(commandId)) return;
    const before = context.store.lastSeq();
    context.store.dispatch(commandId, (current) =>
      build(current, { commandId, at, actor: system }),
    );
    context.publish(context.store.eventsSince(before));
  };
  run("sync", syncChannels);
  run("settle", settleChannelRequests);
}

/**
 * The owner's channel RPCs: list, read, post and act on requests. `tasks` is the task runner;
 * Stop cancels each open task through its ordinary task.cancel.
 */
export function channelApi(
  context: RuntimeContext,
  tasks: {
    api(method: string, params: Record<string, unknown>, commandId?: string): Promise<unknown>;
  },
) {
  async function wakeAll(threadIds: string[]) {
    for (const threadId of threadIds) await context.wake(threadId).catch(() => undefined);
  }
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (!(method in channelMethods)) return undefined;
    parse(channelMethods[method as keyof typeof channelMethods].params, params);
    if (method === "channel.list") {
      const rows = context.store.snapshot(["channel"]).channel ?? [];
      return {
        items: rows
          .filter((row) => !params.projectId || row.projectId === params.projectId)
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      };
    }
    if (method === "channel.read")
      return readChannel(
        context.store.snapshot([...channelKinds]),
        String(params.id),
        typeof params.limit === "number" ? params.limit : 200,
        typeof params.before === "string" ? params.before : undefined,
      );
    if (!commandId) throw new Error("command_id_required");
    if (method === "channel.post") {
      const input = params as { channelId: string; id: string; text: string; mentions?: string[] };
      const id = `channel:post:${input.id}`;
      const check = context.store.receipt(id) ? () => {} : await context.privacy.prepareData(input);
      const before = context.store.lastSeq();
      const receipt = context.store.dispatch(id, (state) => {
        check(state);
        return postOwnerToChannel(
          state,
          {
            channelId: input.channelId,
            postId: input.id,
            text: input.text,
            ...(input.mentions ? { mentions: input.mentions } : {}),
          },
          { commandId: id, at: new Date().toISOString(), actor: owner },
        );
      });
      context.publish(context.store.eventsSince(before));
      const result = receipt.result as { post: { text: string }; request: unknown; wake: string[] };
      if (result.post.text !== input.text) throw new Error("command_receipt_conflict");
      await wakeAll(result.wake);
      return { post: result.post, request: result.request };
    }
    const input = params as {
      id: string;
      action: ChannelRequestAction;
      revision: number;
      leadThreadId?: string;
      confirmed?: boolean;
    };
    const id = `channel:request:${input.id}:${input.revision}:${input.action}`;
    const before = context.store.lastSeq();
    const receipt = context.store.dispatch(id, (state) =>
      channelRequestAction(state, input, {
        commandId: id,
        at: new Date().toISOString(),
        actor: owner,
      }),
    );
    context.publish(context.store.eventsSince(before));
    const result = receipt.result as { request: unknown; cancel: string[]; wake: string[] };
    // The owner confirmed Stop; each task stops through the ordinary task.cancel path.
    for (const taskId of result.cancel)
      await tasks
        .api("task.cancel", { id: taskId, confirmed: true }, `${id}:cancel:${taskId}`)
        .catch(() => undefined);
    await wakeAll(result.wake);
    return result.request;
  };
}
