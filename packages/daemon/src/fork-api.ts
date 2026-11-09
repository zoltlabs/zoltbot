import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { applyEvents, handle } from "@zoltbot/core";
import {
  type DomainEvent,
  type ForkBoundary,
  ForkBoundarySchema,
  type ForkOperation,
  ForkOperationSchema,
  ProfileSchema,
  parse,
  ThreadSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { copiedForks } from "./copied-fork-api.js";
import { forkCeiling, inheritedConfiguration } from "./fork-configuration.js";
import { forkFence, forkSource, historyKey, operationKey } from "./fork-policy.js";
import type { PrivateInputGuard } from "./private-input.js";
import { runtimeConfigurationFence } from "./runtime-configuration.js";
import type { SessionManager } from "./session-manager.js";

export function forkApi(host: {
  store: Store;
  manager?: SessionManager;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
}) {
  const { store } = host;
  const copies = copiedForks(host);
  const inflight = new Map<string, { request: unknown; work: Promise<ForkOperation> }>();
  function commit(id: string, produce: Parameters<Store["dispatch"]>[1]) {
    const seq = store.lastSeq();
    const value = store.dispatch(id, produce).result;
    host.publish(store.eventsSince(seq));
    return value;
  }
  function write(operation: ForkOperation) {
    return commit(`fork:${operation.id}:${operation.state}`, (state) =>
      handle(
        state,
        {
          type: "update",
          kind: "settings",
          id: operationKey(operation.id),
          changes: { value: operation },
        },
        {
          commandId: `fork:${operation.id}:${operation.state}`,
          at: new Date().toISOString(),
          actor: { kind: "system", id: "runtime" },
        },
      ),
    );
  }
  function operation(id: string) {
    return parse(ForkOperationSchema, store.record("settings", operationKey(id))?.value);
  }
  // No interrupted dispatch may repeat a provider side effect on daemon restart.
  for (const row of store.snapshot(["settings"]).settings ?? []) {
    if (!String(row.key).startsWith("fork.operation.")) continue;
    const op = parse(ForkOperationSchema, row.value);
    if (!["ready", "failed", "needs_reconciliation"].includes(op.state))
      write({ ...op, state: "needs_reconciliation", error: "fork_interrupted" });
  }
  function preview(id: string, boundary: ForkBoundary) {
    const state = store.snapshot();
    const source = forkSource(state, id, boundary);
    const profile = parse(
      ProfileSchema,
      state.agent?.find((r) => r.id === source.thread.agentId && !r.archived),
    );
    const configuration = store.record("settings", `runtime.configuration.${source.session.id}`)
      ?.value as { profile?: { permissionProfile?: typeof profile.permissionProfile } } | undefined;
    const ceiling = forkCeiling(
      profile.permissionProfile,
      configuration?.profile?.permissionProfile ?? "read_only",
      state.compareMember?.find((r) => r.threadId === id)?.ceiling === "read_only"
        ? "read_only"
        : source.thread.fork?.permissionCeiling,
    );
    const saved = inheritedConfiguration(configuration, "preview", ceiling);
    return { source, profile, ceiling, saved };
  }
  async function perform(
    id: string,
    title: string,
    boundary: ForkBoundary,
    commandId: string,
  ): Promise<ForkOperation> {
    const manager = host.manager;
    if (!manager) throw Error("runtime_unavailable");
    const prior = store.receipt<{ request: unknown; operationId: string }>(commandId);
    const request = { id, title, boundary };
    if (prior) {
      if (!isDeepStrictEqual(prior.result.request, request))
        throw Error("command_receipt_conflict");
      return operation(prior.result.operationId);
    }
    return manager.withForkSource(id, async () => {
      const { source, profile, ceiling, saved } = preview(id, boundary);
      const sourceFence = runtimeConfigurationFence(store.snapshot(), id);
      const check = await host.privacy.prepareData({ title });
      const state = store.snapshot();
      forkSource(state, id, boundary);
      const childId = randomUUID(),
        now = new Date().toISOString();
      const child = parse(ThreadSchema, {
        id: childId,
        agentId: profile.id,
        ...(source.thread.projectId ? { projectId: source.thread.projectId } : {}),
        ...(source.thread.node ? { node: source.thread.node } : {}),
        kind: "side",
        title,
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: now,
        lastActivityAt: now,
        fork: {
          kind: "native",
          operationId: commandId,
          sourceThreadId: id,
          sourceSessionId: source.session.id,
          sourceNativeId: source.session.nativeId,
          cwd: source.session.cwd,
          boundary,
          permissionCeiling: ceiling,
          inheritedHistoryPresent: true,
          ...(source.thread.taskId ? { sourceTaskId: source.thread.taskId } : {}),
          ...((state.task?.find((r) => r.id === source.thread.taskId)?.workspaceId ??
          source.thread.fork?.workspaceId)
            ? {
                workspaceId: String(
                  state.task?.find((r) => r.id === source.thread.taskId)?.workspaceId ??
                    source.thread.fork?.workspaceId,
                ),
              }
            : {}),
        },
      });
      let history =
        (state.settings?.find((r) => r.key === historyKey(id))?.value as unknown[] | undefined) ??
        [];
      const own = (state.item ?? [])
        .filter((r) => r.threadId === id)
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      if (boundary.kind !== "latest") {
        const selected = state.turn?.find((r) => r.id === boundary.turnId);
        const cutoff = own.filter((r) => r.turnId === selected?.id);
        if (!cutoff.length) throw Error("fork_boundary_unavailable");
        const end =
          boundary.kind === "before_user"
            ? Math.min(...cutoff.map((r) => Number(r.seq))) - 1
            : Math.max(...cutoff.map((r) => Number(r.seq)));
        history = [...history, ...own.filter((r) => Number(r.seq) <= end)];
      } else history = [...history, ...own];
      if (history.length > 2000 || Buffer.byteLength(JSON.stringify(history)) > 2_000_000)
        throw Error("fork_history_limit");
      let op: ForkOperation = {
        id: commandId,
        kind: "native",
        destinationProfileId: profile.id,
        sourceThreadId: id,
        childThreadId: childId,
        title,
        boundary,
        state: "requested",
        createdAt: now,
      };
      const childConfiguration = inheritedConfiguration(saved, childId, ceiling);
      const caps = source.session.capabilities as { nativeFork?: { callerId?: boolean } };
      if (caps.nativeFork?.callerId) op.targetNativeId = randomUUID();
      commit(commandId, (initial) => {
        check(initial);
        sourceFence(initial);
        forkSource(initial, id, boundary);
        let current = initial;
        const events: DomainEvent[] = [];
        for (const [kind, value] of [
          ["thread", child],
          ["settings", { key: historyKey(childId), value: history }],
          ["settings", { key: operationKey(commandId), value: op }],
        ] as const) {
          const outcome = handle(
            current,
            { type: "create", kind, value },
            {
              commandId: `${commandId}:${events.length}`,
              at: now,
              actor: { kind: "human", id: "local-owner" },
            },
          );
          events.push(...outcome.events);
          current = applyEvents(current, outcome.events);
        }
        return { events, result: { request, operationId: commandId } };
      });
      const fence = forkFence(store.snapshot(), id, childId);
      op = { ...op, state: "dispatching" };
      write(op);
      try {
        const nativeId = await manager.forkChild(
          childId,
          {
            nativeId: source.session.nativeId as string,
            cwd: source.session.cwd,
            provider: source.session.provider,
            configuration: childConfiguration,
            firstPromptPending: false,
            sourceThreadId: id,
          },
          {
            sourceNativeId: source.session.nativeId as string,
            sourceCwd: source.session.cwd,
            ...(op.targetNativeId ? { targetNativeId: op.targetNativeId } : {}),
            boundary:
              boundary.kind === "latest"
                ? { kind: "latest" }
                : { kind: boundary.kind, nativeId: source.nativeBoundary as string },
          },
        );
        op = { ...op, targetNativeId: nativeId, state: "native_created" };
        write(op);
        fence(store.snapshot());
        op = { ...op, state: "activating" };
        write(op);
        op = { ...op, state: "ready" };
        write(op);
        commit(`${commandId}:audit`, (s) =>
          handle(
            s,
            {
              type: "create",
              kind: "audit",
              value: {
                id: `fork:${commandId}`,
                actor: { kind: "human", id: "local-owner" },
                action: "thread.fork",
                target: childId,
                result: "allowed",
                detail: { sourceThreadId: id, boundary },
                at: now,
              },
            },
            { commandId: `${commandId}:audit`, at: now, actor: { kind: "system", id: "runtime" } },
          ),
        );
      } catch {
        const session = (store.snapshot(["session"]).session ?? []).find(
          (r) =>
            r.threadId === childId && ["ready", "running", "starting"].includes(String(r.state)),
        );
        if (session) await manager.stopSession(String(session.id)).catch(() => {});
        op = { ...op, state: "needs_reconciliation", error: "fork_native_outcome_uncertain" };
        write(op);
      }
      return op;
    });
  }
  return async (
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<unknown> => {
    if (!method.startsWith("thread.fork")) return undefined;
    const id = String(params.id);
    if (method === "thread.forkGet") return operation(id);
    if (method === "thread.forkHistory")
      return { items: store.record("settings", historyKey(id))?.value ?? [] };
    const boundary = parse(ForkBoundarySchema, params.boundary ?? { kind: "latest" });
    if (method === "thread.fork" || method === "thread.forkPreview") {
      try {
        const choice = copies.select(id, params);
        if (choice.kind === "copied") {
          if (method === "thread.forkPreview") {
            const p = copies.preview(id, params);
            return {
              available: true,
              kind: "copied",
              destinationProfileId: choice.destinationProfileId,
              destinations: copies.destinations(),
              cwd: p.source.session.cwd,
              copiedMessages: p.context.copiedMessages,
              omittedMessages: p.context.omittedMessages,
            };
          }
          if (!commandId) throw Error("command_id_required");
          return await copies.create(id, params, commandId);
        }
      } catch (error) {
        if (method !== "thread.forkPreview") throw error;
        return {
          available: false,
          kind: params.kind ?? "copied",
          destinations: copies.destinations(),
          reason: error instanceof Error ? error.message : "fork_unavailable",
        };
      }
    }
    if (method === "thread.forkPreview") {
      try {
        const p = preview(id, boundary);
        return {
          available: true,
          kind: "native",
          destinationProfileId: p.profile.id,
          destinations: copies.destinations(),
          reason: "",
          cwd: p.source.session.cwd,
          provider: p.source.session.provider,
          permissionProfile: p.ceiling,
        };
      } catch (error) {
        return {
          available: false,
          kind: "native",
          destinations: copies.destinations(),
          reason: error instanceof Error ? error.message : "fork_unavailable",
        };
      }
    }
    if (method !== "thread.fork") return undefined;
    if (!commandId) throw Error("command_id_required");
    const title =
      typeof params.title === "string"
        ? params.title
        : `${store.record("thread", id)?.title ?? "Conversation"} · fork`;
    const request = { id, title, boundary };
    const pending = inflight.get(commandId);
    if (pending) {
      if (!isDeepStrictEqual(pending.request, request)) throw Error("command_receipt_conflict");
      return pending.work;
    }
    const work = perform(id, title, boundary, commandId).finally(() => inflight.delete(commandId));
    inflight.set(commandId, { request, work });
    return work;
  };
}
