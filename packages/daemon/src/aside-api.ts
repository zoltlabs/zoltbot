// C2: a side question asked while the agent works. It runs in a hidden, read-only copy of the chat
// (kind "aside"), so the running turn, its queue and its native session never see it.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { applyEvents, handle } from "@zoltbot/core";
import {
  compareSessions,
  type DomainEvent,
  type ForkOperation,
  ProfileSchema,
  parse,
  ThreadSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { copiedContext, copiedContextKey, visibleForkHistory } from "./copied-fork-context.js";
import { operationKey } from "./fork-policy.js";
import type { PrivateInputGuard } from "./private-input.js";

type Send = (method: string, params: Record<string, unknown>, commandId?: string) => unknown;

function ask(send: Send, threadId: string, text: string, commandId: string) {
  return send(
    "turn.send",
    { threadId, input: [{ type: "text", text }], mode: "queue" },
    `${commandId}:ask`,
  );
}

/** Title shown if the aside is continued as a chat: the question's first line, shortened. */
export function asideTitle(text: string) {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || "Aside";
}

export function asideApi(host: {
  store: Store;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
  send?: Send;
}) {
  const { store } = host;
  const inflight = new Map<string, { request: unknown; work: Promise<{ threadId: string }> }>();

  async function create(threadId: string, text: string, commandId: string) {
    const send = host.send;
    if (!send) throw Error("runtime_unavailable");
    const request = { threadId, text };
    const prior = store.receipt<{ request: unknown; threadId: string }>(commandId);
    if (prior) {
      if (!isDeepStrictEqual(prior.result.request, request))
        throw Error("command_receipt_conflict");
      // A crash or error after the aside was made but before it was asked: ask now. The send has
      // its own receipt, so a question already asked isn't asked twice.
      await ask(send, prior.result.threadId, text, commandId);
      return { threadId: prior.result.threadId };
    }
    const state = store.snapshot();
    const source = state.thread?.find((r) => r.id === threadId && !r.archived);
    if (!source || source.kind === "aside") throw Error("aside_unavailable");
    const profile = parse(
      ProfileSchema,
      state.agent?.find((r) => r.id === source.agentId && !r.archived),
    );
    const session = (state.session ?? [])
      .filter((r) => r.threadId === threadId)
      .sort(compareSessions)[0];
    if (!session) throw Error("aside_unavailable");
    let context: ReturnType<typeof copiedContext>;
    try {
      context = copiedContext(visibleForkHistory(state, threadId));
    } catch {
      throw Error("aside_unavailable");
    }
    const title = asideTitle(text);
    const check = await host.privacy.prepareData({ title, context });
    const childId = randomUUID(),
      now = new Date().toISOString();
    const workspaceId =
      state.task?.find((r) => r.id === source.taskId)?.workspaceId ??
      (source.fork as { workspaceId?: string } | undefined)?.workspaceId;
    const child = parse(ThreadSchema, {
      id: childId,
      agentId: profile.id,
      kind: "aside",
      title,
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: now,
      lastActivityAt: now,
      ...(source.projectId ? { projectId: source.projectId } : {}),
      ...(source.node ? { node: source.node } : {}),
      fork: {
        kind: "copied",
        operationId: commandId,
        sourceThreadId: threadId,
        sourceSessionId: String(session.id),
        ...(session.nativeId ? { sourceNativeId: String(session.nativeId) } : {}),
        cwd: String(session.cwd),
        boundary: { kind: "latest" },
        // An aside reads; it never changes files, whatever the chat itself may do.
        permissionCeiling: "read_only",
        inheritedHistoryPresent: false,
        copiedMessages: context.copiedMessages,
        omittedMessages: context.omittedMessages,
        ...(workspaceId ? { workspaceId: String(workspaceId) } : {}),
      },
    });
    const operation: ForkOperation = {
      id: commandId,
      kind: "copied",
      destinationProfileId: profile.id,
      sourceThreadId: threadId,
      childThreadId: childId,
      title,
      boundary: { kind: "latest" },
      state: "ready",
      createdAt: now,
    };
    const seq = store.lastSeq();
    const result = store.dispatch(commandId, (initial) => {
      check(initial);
      if (!initial.thread?.some((r) => r.id === threadId && !r.archived))
        throw Error("aside_unavailable");
      let current = initial;
      const events: DomainEvent[] = [];
      for (const [kind, value] of [
        ["thread", child],
        ["settings", { key: operationKey(commandId), value: operation }],
        ["settings", { key: copiedContextKey(childId), value: context }],
      ] as const) {
        const out = handle(
          current,
          { type: "create", kind, value },
          {
            commandId: `${commandId}:${events.length}`,
            at: now,
            actor: { kind: "human", id: "local-owner" },
          },
        );
        events.push(...out.events);
        current = applyEvents(current, out.events);
      }
      return { events, result: { request, threadId: childId } };
    }).result;
    host.publish(store.eventsSince(seq));
    await ask(send, result.threadId, text, commandId);
    return { threadId: result.threadId };
  }

  function keep(id: string, commandId: string | undefined) {
    if (!commandId) throw Error("command_id_required");
    const seq = store.lastSeq();
    const value = store.dispatch(commandId, (state) => {
      const thread = state.thread?.find((r) => r.id === id);
      if (!thread) throw Error("thread_not_found");
      if (thread.kind !== "aside") return { events: [], result: thread };
      return handle(
        state,
        { type: "update", kind: "thread", id, changes: { kind: "side" } },
        {
          commandId,
          at: new Date().toISOString(),
          actor: { kind: "human", id: "local-owner" },
        },
      );
    }).result;
    host.publish(store.eventsSince(seq));
    return parse(ThreadSchema, store.record("thread", id) ?? value);
  }

  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    if (method === "thread.continueAside") return keep(String(params.id), commandId);
    if (method !== "turn.aside") return undefined;
    if (!commandId) throw Error("command_id_required");
    const threadId = String(params.threadId);
    const text = String(params.text ?? "");
    if (!text.trim()) throw Error("aside_text_required");
    const request = { threadId, text };
    const pending = inflight.get(commandId);
    if (pending) {
      if (!isDeepStrictEqual(pending.request, request)) throw Error("command_receipt_conflict");
      return pending.work;
    }
    const work = create(threadId, text, commandId).finally(() => inflight.delete(commandId));
    inflight.set(commandId, { request, work });
    return work;
  };
}
