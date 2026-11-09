import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { applyEvents, handle } from "@zoltbot/core";
import {
  compareSessions,
  type DomainEvent,
  type ForkBoundary,
  type ForkOperation,
  ForkOperationSchema,
  ProfileSchema,
  parse,
  ThreadSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { copiedContext, copiedContextKey, visibleForkHistory } from "./copied-fork-context.js";
import { forkCeiling } from "./fork-configuration.js";
import { forkFence, forkSource, historyKey, operationKey } from "./fork-policy.js";
import type { PrivateInputGuard } from "./private-input.js";
import type { SessionManager } from "./session-manager.js";

export function copiedForks(host: {
  store: Store;
  manager?: SessionManager;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
}) {
  const { store } = host;
  const inflight = new Map<string, { request: unknown; work: Promise<ForkOperation> }>();
  function select(id: string, params: Record<string, unknown>) {
    const thread = store.record("thread", id);
    const destinationProfileId = String(params.destinationProfileId ?? thread?.agentId);
    const profile = parse(ProfileSchema, store.record("agent", destinationProfileId));
    if (
      profile.archived ||
      (profile.kind !== "profile" && destinationProfileId !== thread?.agentId)
    )
      throw Error("fork_destination_unavailable");
    const session = store
      .snapshot(["session"])
      .session?.filter((s) => s.threadId === id)
      .sort(compareSessions)[0];
    const capable = (
      session?.capabilities as
        | { nativeFork?: { latest?: boolean; activation?: string } }
        | undefined
    )?.nativeFork;
    const native =
      destinationProfileId === thread?.agentId &&
      !!session?.nativeId &&
      capable?.latest &&
      capable.activation !== "deferred";
    if (params.kind === "native" && !native) throw Error("native_fork_unverified");
    return {
      kind: params.kind === "copied" || !native ? ("copied" as const) : ("native" as const),
      destinationProfileId,
      profile,
    };
  }
  function destinations() {
    const state = store.snapshot(["agent", "agentDefinition"]);
    return (state.agent ?? [])
      .filter(
        (r) =>
          !r.archived &&
          !r.hidden &&
          r.kind === "profile" &&
          state.agentDefinition?.some((d) => d.id === r.definitionId),
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        tool: state.agentDefinition?.find((d) => d.id === r.definitionId)?.displayName,
      }));
  }
  function preview(id: string, params: Record<string, unknown>) {
    const boundary = (params.boundary as ForkBoundary | undefined) ?? { kind: "latest" };
    const choice = select(id, params);
    const state = store.snapshot();
    const source = forkSource(state, id, { kind: "latest" }, false);
    const history = visibleForkHistory(state, id, boundary);
    if (history.length > 2000 || Buffer.byteLength(JSON.stringify(history)) > 2_000_000)
      throw Error("fork_history_limit");
    const context = copiedContext(history);
    const sourceProfile = parse(ProfileSchema, store.record("agent", source.thread.agentId));
    const configuration = store.record("settings", `runtime.configuration.${source.session.id}`)
      ?.value as
      | { profile?: { permissionProfile?: typeof sourceProfile.permissionProfile } }
      | undefined;
    let ceiling = forkCeiling(
      choice.profile.permissionProfile,
      sourceProfile.permissionProfile,
      undefined,
    );
    ceiling = forkCeiling(
      ceiling,
      configuration?.profile?.permissionProfile ?? "read_only",
      undefined,
    );
    ceiling = forkCeiling(
      ceiling,
      source.thread.fork?.permissionCeiling ?? ceiling,
      state.compareMember?.find((r) => r.threadId === id)?.ceiling,
    );
    return { choice, source, context, ceiling };
  }
  async function create(
    id: string,
    params: Record<string, unknown>,
    commandId: string,
  ): Promise<ForkOperation> {
    if (!host.manager) throw Error("runtime_unavailable");
    const title =
      typeof params.title === "string"
        ? params.title
        : `${store.record("thread", id)?.title ?? "Conversation"} · fork`;
    const request = {
      id,
      title,
      boundary: params.boundary ?? { kind: "latest" },
      destinationProfileId: String(
        params.destinationProfileId ?? store.record("thread", id)?.agentId,
      ),
      kind: "copied",
    };
    const prior = store.receipt<{ request: unknown; operationId: string }>(commandId);
    if (prior) {
      if (!isDeepStrictEqual(prior.result.request, request))
        throw Error("command_receipt_conflict");
      return parse(
        ForkOperationSchema,
        store.record("settings", operationKey(prior.result.operationId))?.value,
      );
    }
    const pending = inflight.get(commandId);
    if (pending) {
      if (!isDeepStrictEqual(pending.request, request)) throw Error("command_receipt_conflict");
      return pending.work;
    }
    const work = host.manager
      .withForkSource(id, async () => {
        const { choice, source, context, ceiling } = preview(id, params);
        const boundary = request.boundary as ForkBoundary;
        const history = visibleForkHistory(store.snapshot(), id, boundary);
        if (history.length > 2000 || Buffer.byteLength(JSON.stringify(history)) > 2_000_000)
          throw Error("fork_history_limit");
        const fence = forkFence(store.snapshot(), id, id);
        const check = await host.privacy.prepareData({ title, history, context });
        const childId = randomUUID(),
          now = new Date().toISOString();
        const workspaceId =
          store.record("task", source.thread.taskId ?? "")?.workspaceId ??
          source.thread.fork?.workspaceId;
        const child = parse(ThreadSchema, {
          id: childId,
          agentId: choice.destinationProfileId,
          kind: "side",
          title,
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: now,
          lastActivityAt: now,
          ...(source.thread.projectId ? { projectId: source.thread.projectId } : {}),
          ...(source.thread.node ? { node: source.thread.node } : {}),
          fork: {
            kind: "copied",
            operationId: commandId,
            sourceThreadId: id,
            sourceSessionId: source.session.id,
            ...(source.session.nativeId ? { sourceNativeId: source.session.nativeId } : {}),
            cwd: source.session.cwd,
            boundary,
            permissionCeiling: ceiling,
            inheritedHistoryPresent: false,
            copiedMessages: context.copiedMessages,
            omittedMessages: context.omittedMessages,
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
        const operation: ForkOperation = {
          id: commandId,
          kind: "copied",
          destinationProfileId: choice.destinationProfileId,
          sourceThreadId: id,
          childThreadId: childId,
          title,
          boundary,
          state: "ready",
          createdAt: now,
        };
        const seq = store.lastSeq();
        const result = store.dispatch(commandId, (initial) => {
          check(initial);
          fence(initial);
          preview(id, params);
          let current = initial;
          const events: DomainEvent[] = [];
          for (const [kind, value] of [
            ["thread", child],
            ["settings", { key: operationKey(commandId), value: operation }],
            ["settings", { key: historyKey(childId), value: history }],
            ["settings", { key: copiedContextKey(childId), value: context }],
            [
              "audit",
              {
                id: `fork:${commandId}`,
                actor: { kind: "human", id: "local-owner" },
                action: "thread.fork",
                target: childId,
                result: "allowed",
                detail: {
                  kind: "copied",
                  sourceThreadId: id,
                  destinationProfileId: choice.destinationProfileId,
                },
                at: now,
              },
            ],
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
          return { events, result: { request, operationId: commandId } };
        }).result;
        host.publish(store.eventsSince(seq));
        return parse(
          ForkOperationSchema,
          store.record("settings", operationKey(result.operationId))?.value,
        );
      })
      .finally(() => inflight.delete(commandId));
    inflight.set(commandId, { request, work });
    return work;
  }
  return { select, destinations, preview, create };
}
