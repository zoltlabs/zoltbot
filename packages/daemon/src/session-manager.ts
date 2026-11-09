import { randomUUID } from "node:crypto";
import type { AgentSession, NativeForkTarget } from "@zoltbot/adapters-sdk";
import {
  type CommandContext,
  comparePermission,
  type DomainState,
  handle,
  type Outcome,
  requestNativeCompaction,
  requestTurnInterrupt,
  routineProfile,
  settleNativeCompaction,
} from "@zoltbot/core";
import {
  AgentDefinitionSchema,
  type AgentEvent,
  compareSessions,
  type Interaction,
  ProfileSchema,
  parse,
  type QueuedInputBody,
  QueuedInputBodySchema,
  ThreadSchema,
  type UserInput,
} from "@zoltbot/protocol";
import { approvalPaths, canonicalApprovalRoot } from "./approval-paths.js";
import { claimManifestOpen, interruptedLaunchConfiguration } from "./connections-delivery.js";
import { createSessionLaunchIntent } from "./connections-intent.js";
import { launchPreflight } from "./connections-preflight.js";
import { forkPermission } from "./fork-configuration.js";
import { type ForkLaunch, forkLifecycle } from "./fork-lifecycle.js";
import type { InteractionEngine, InteractionHost } from "./interaction-engine.js";
import { Redactor } from "./logging.js";
import type { PrivateContexts } from "./private-context.js";
import { PrivateInputGuard } from "./private-input.js";
import {
  type Previous,
  previousForThread,
  runtimeConfigurationFence,
  runtimeConfigurationKinds,
} from "./runtime-configuration.js";
import { runtimeCapabilityErrors, runtimeOpenErrors } from "./runtime-errors.js";
import {
  commitRuntime,
  type RuntimeEntry,
  runtimeEntryFor,
  type SessionManagerOptions,
} from "./runtime-host.js";

export type { PreparedRuntime, RuntimeHost } from "./runtime-host.js";

import { resolveRuntimeCredentials } from "./runtime-credentials.js";
import { RuntimeWorker } from "./runtime-worker.js";

export class SessionManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly opening = new Map<string, Promise<RuntimeWorker>>();
  private readonly forks: ReturnType<typeof forkLifecycle>;
  private readonly interrupting = new Map<
    string,
    { threadId: string; turnId: string; work: Promise<{ ok: true }> }
  >();
  private readonly commands = new Set<Promise<unknown>>();
  private readonly failedHandles = new Map<string, AgentSession>();
  private engine: InteractionEngine | undefined;
  private stopped = false;
  private closing: Promise<void> | undefined;
  private readonly privateContexts: PrivateContexts | undefined;
  private readonly privacy: PrivateInputGuard;
  constructor(private readonly options: SessionManagerOptions) {
    this.forks = forkLifecycle({
      store: this.options.store,
      opening: this.opening,
      stopped: () => this.stopped,
      holdSource: (id) => this.entries.get(id)?.worker.holdDispatch() ?? (() => {}),
      open: (id, fork) => this.open(id, fork),
      nativeId: (id) => this.entries.get(id)?.native.nativeId,
      track: (work) => this.track(work),
    });

    this.privacy =
      options.privacy ??
      new PrivateInputGuard({
        store: options.store,
        publish: options.publish,
        ...(options.secrets ? { secrets: options.secrets } : {}),
      });
    this.privateContexts = this.privacy.contexts;
  }
  private entryFor(request: Interaction) {
    return runtimeEntryFor(this.entries, this.options.store, request);
  }
  get interactionHost(): InteractionHost {
    return {
      requiresSecretReply: () => true,
      approvalPaths: (request, sourcePaths) => {
        if (!sourcePaths?.length || request.context?.paths?.length !== sourcePaths.length)
          return undefined;
        const entry = this.entryFor(request);
        const session = this.options.store
          .snapshot(["session"])
          .session?.find((row) => row.id === entry.sessionId);
        const current =
          typeof session?.cwd === "string" ? canonicalApprovalRoot(session.cwd) : undefined;
        return entry.approvalRoot &&
          current &&
          current.path === entry.approvalRoot.path &&
          current.device === entry.approvalRoot.device &&
          current.inode === entry.approvalRoot.inode
          ? approvalPaths(entry.approvalRoot.path, sourcePaths)
          : undefined;
      },
      registerSecret: (value, request) => {
        const entry = this.entryFor(request),
          key = `runtime.private.${entry.sessionId}`;
        this.privacy.cover(entry.sessionId);
        if (
          !this.privateContexts &&
          !this.options.store.snapshot(["settings"]).settings?.some((row) => row.key === key)
        )
          this.commit((state, context) =>
            handle(
              state,
              { type: "create", kind: "settings", value: { key, value: true } },
              context,
            ),
          );
        entry.redactor.register(value);
        entry.privateValues.add(value);
        this.privacy.remember(value);
        this.privacy.hideFrames();
      },
      preparePublicAnswer: (request, answer) => this.privacy.prepareAnswer(request, answer),
      prepareInput: (input) => this.prepareInput(input),
      ...(this.privateContexts
        ? {
            persistPrivateContext: async (request: Interaction) => {
              const entry = this.entryFor(request);
              await this.privateContexts?.persist(entry.sessionId, entry.privateValues);
            },
          }
        : {}),
      respond: async (request, answer) => {
        const entry = this.entryFor(request);
        if (
          request.turnId &&
          !this.options.store
            .snapshot()
            .turn?.some(
              (row) =>
                row.id === request.turnId &&
                row.sessionId === entry.sessionId &&
                row.status === "running",
            )
        )
          throw new Error("interaction_turn_ended");
        const nativeId = entry.worker.nativeInteractionId(request.id);
        const release = entry.worker.holdDispatch();
        try {
          await entry.native.respond(nativeId, answer);
        } catch {
          const laterTurn = this.options.store
            .snapshot()
            .turn?.some(
              (row) =>
                row.sessionId === entry.sessionId &&
                row.status === "running" &&
                row.id !== request.turnId,
            );
          if (!laterTurn) {
            try {
              await entry.worker.close("interaction_delivery_uncertain");
            } catch {
              this.failedHandles.set(request.threadId, entry.native);
              this.options.onError?.("runtime_cleanup_failed");
            }
          }
          throw new Error("interaction_reply_failed");
        } finally {
          release();
        }
      },
      stopTurn: async (request) => {
        await this.entryFor(request).worker.close("interaction_timeout");
      },
    };
  }
  prepareInput(input: UserInput): Promise<(state: DomainState) => void> {
    return this.privacy.prepareInput(input);
  }
  private async interaction(
    threadId: string,
    sessionId: string,
    event: Extract<AgentEvent, { t: "interaction.requested" | "interaction.cleared" }>,
    approvalSourcePaths?: readonly string[],
  ) {
    const engine = await this.options.interactions?.();
    if (this.stopped) throw new Error("runtime_closed");
    if (!engine) throw new Error("runtime_interaction_host_required");
    this.engine = engine;
    if (event.t === "interaction.requested")
      engine.request(
        event.interaction,
        `native-request:${event.interaction.id}`,
        { kind: "system", id: "runtime" },
        approvalSourcePaths,
      );
    else {
      const state = this.options.store.snapshot();
      const ids = (state.interaction ?? [])
        .filter(
          (row) =>
            row.threadId === threadId &&
            row.nativeRef === event.nativeRef &&
            (!row.turnId ||
              state.turn?.some((turn) => turn.id === row.turnId && turn.sessionId === sessionId)),
        )
        .map((row) => String(row.id));
      engine.clearRequests(
        ids,
        event.reason === "process_died"
          ? "process_died"
          : event.reason === "turn_ended"
            ? "turn_ended"
            : "provider_cleared",
        `native-clear:${randomUUID()}`,
      );
    }
  }
  private commit(produce: (state: DomainState, context: CommandContext) => Outcome) {
    return commitRuntime(this.options, produce);
  }
  assertMutable(id: string) {
    this.forks.assertMutable(id);
  }
  withForkSource<T>(id: string, work: () => Promise<T>) {
    return this.forks.withSource(id, work);
  }
  forkChild(id: string, source: ForkLaunch["source"], target: NativeForkTarget) {
    return this.forks.child(id, source, target);
  }
  async preflight(threadId: string): Promise<void> {
    this.assertMutable(threadId);
    if (this.entries.has(threadId)) return;
    await launchPreflight(this.options.store, this.options.host, threadId, this.options.secrets);
  }
  ensure(threadId: string): Promise<RuntimeWorker> {
    try {
      this.assertMutable(threadId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.stopped) return Promise.reject(new Error("runtime_closed"));
    if (
      this.failedHandles.has(threadId) ||
      this.options.store
        .snapshot()
        .session?.some(
          (row) => row.threadId === threadId && row.endReason === "runtime_cleanup_required",
        )
    )
      return Promise.reject(new Error("runtime_cleanup_required"));
    const opening = this.opening.get(threadId);
    if (opening) return opening;
    const entry = this.entries.get(threadId);
    if (entry) {
      const row = this.options.store.snapshot().session?.find((row) => row.id === entry.sessionId);
      if (row && ["starting", "ready", "running"].includes(String(row.state)))
        return Promise.resolve(entry.worker);
    }
    const work = this.open(threadId)
      .catch((error) => {
        const code = error instanceof Error ? (error.message.split(":")[0] ?? "") : "";
        throw new Error(runtimeOpenErrors.includes(code) ? code : "runtime_open_failed");
      })
      .finally(() => this.opening.delete(threadId));
    this.opening.set(threadId, work);
    return work;
  }
  private async open(threadId: string, fork?: ForkLaunch) {
    const old = this.entries.get(threadId);
    if (old) {
      await old.worker.close();
      this.entries.delete(threadId);
    }
    const state = this.options.store.snapshot();
    const thread = parse(
      ThreadSchema,
      state.thread?.find((row) => row.id === threadId && !row.archived),
    );
    const profile = routineProfile(
      state,
      thread.taskId,
      parse(
        ProfileSchema,
        state.agent?.find((row) => row.id === thread.agentId && !row.archived),
      ),
    );
    const definition = parse(
      AgentDefinitionSchema,
      state.agentDefinition?.find((row) => row.id === profile.definitionId),
    );
    if (
      state.session?.some(
        (row) =>
          row.threadId === threadId && ["starting", "ready", "running"].includes(String(row.state)),
      )
    )
      throw new Error("runtime_session_owned");
    for (const row of state.item ?? []) {
      if (row.threadId !== threadId || row.kind !== "user") continue;
      let body: QueuedInputBody;
      try {
        body = parse(QueuedInputBodySchema, row.body);
      } catch {
        continue;
      }
      if (["sending", "uncertain"].includes(body.queueState))
        throw new Error("runtime_input_review_required");
    }
    const previous: Previous | undefined = fork
      ? { ...previousForThread(state, fork.source.sourceThreadId), ...fork.source }
      : previousForThread(state, threadId);
    if (previous && previous.provider !== definition.adapter)
      throw Error("native_provider_changed");
    let configurationCheck = runtimeConfigurationFence(state, threadId);
    const checkConfiguration = () =>
      configurationCheck(this.options.store.snapshot(runtimeConfigurationKinds));
    const redactor = new Redactor();
    this.privacy.track(redactor);
    const protectedValues =
      previous?.privateContextRequired && this.privateContexts
        ? await this.privateContexts.restore(
            (state.session ?? [])
              .filter(
                (row) =>
                  row.threadId === (fork?.source.sourceThreadId ?? threadId) &&
                  row.nativeId === previous.nativeId &&
                  row.provider === previous.provider &&
                  row.cwd === previous.cwd,
              )
              .sort(compareSessions)
              .map((row) => String(row.id)),
            redactor,
          )
        : undefined;
    const resolved = await resolveRuntimeCredentials(definition, this.options.secrets, redactor);
    for (const value of resolved.privateValues ?? []) this.privacy.remember(value);
    if (this.stopped) throw new Error("runtime_closed");
    checkConfiguration();
    const prepared = await this.options.host.prepare(
      {
        thread,
        routineInputs: state.task?.find((row) => row.id === thread.taskId)?.routineInputs as
          | import("@zoltbot/protocol").Routine["template"]["inputs"]
          | undefined,
        profile: {
          ...profile,
          permissionProfile:
            comparePermission(state, threadId, profile) ??
            forkPermission(thread, profile.permissionProfile),
        },
        comparePermission: comparePermission(state, threadId, profile),
        definition: resolved.definition,
        ...(previous
          ? { previous }
          : { launchConfiguration: interruptedLaunchConfiguration(state, threadId) }),
      },
      redactor,
    );
    checkConfiguration();
    if (prepared.privateValues) {
      if (
        !Array.isArray(prepared.privateValues) ||
        prepared.privateValues.some((value) => typeof value !== "string") ||
        Buffer.byteLength(JSON.stringify(prepared.privateValues)) > 16384
      )
        throw new Error("runtime_private_context_required");
      for (const value of prepared.privateValues) redactor.register(value);
      if (prepared.privateValues.length) redactor.hideFrames();
    }
    if (this.stopped) throw new Error("runtime_closed");
    if (
      previous?.privateContextRequired &&
      (!(protectedValues || prepared.privateContextRestored) || !redactor.hidesFrames)
    )
      throw new Error("runtime_private_context_required");
    if (previous && previous.cwd !== prepared.cwd) throw new Error("native_cwd_changed");
    const privateValues = new Set([
      ...(protectedValues ?? []),
      ...(prepared.privateValues ?? []),
      ...(resolved.privateValues ?? []),
    ]);
    for (const value of privateValues) this.privacy.remember(value);
    if (protectedValues !== undefined || prepared.privateValues !== undefined)
      for (const row of state.session ?? []) {
        if (
          previous &&
          row.threadId === threadId &&
          row.provider === previous.provider &&
          row.cwd === previous.cwd &&
          row.nativeId === previous.nativeId
        )
          this.privacy.cover(String(row.id));
      }
    const privacyCheck = await this.privacy.prepareData(prepared.configuration);
    const sessionId = randomUUID();
    this.commit((snapshot, context) => {
      privacyCheck(snapshot);
      configurationCheck(snapshot);
      prepared.validateLaunch?.();
      return createSessionLaunchIntent(
        snapshot,
        context,
        {
          sessionId,
          threadId,
          provider: definition.adapter,
          cwd: prepared.cwd,
          ...(!fork && previous ? { nativeId: previous.nativeId } : {}),
          ...((prepared.configuration ? prepared.model : profile.model)
            ? { model: prepared.configuration ? prepared.model : profile.model }
            : {}),
          ...((prepared.configuration ? prepared.effort : profile.effort)
            ? { effort: prepared.configuration ? prepared.effort : profile.effort }
            : {}),
          ...(prepared.configuration ? { configuration: prepared.configuration } : {}),
        },
        this.options.store,
      );
    });
    configurationCheck = runtimeConfigurationFence(
      this.options.store.snapshot(runtimeConfigurationKinds),
      threadId,
    );
    let native: AgentSession | undefined;
    let worker: RuntimeWorker | undefined;
    try {
      if (privateValues.size) {
        this.privacy.cover(sessionId);
        if (this.privateContexts) await this.privateContexts.persist(sessionId, privateValues);
        else
          this.commit((state, context) =>
            handle(
              state,
              {
                type: "create",
                kind: "settings",
                value: { key: `runtime.private.${sessionId}`, value: true },
              },
              context,
            ),
          );
      }
      checkConfiguration();
      const approvalRoot = canonicalApprovalRoot(prepared.cwd);
      claimManifestOpen(
        this.options.store,
        sessionId,
        prepared.configuration,
        this.options.publish,
      );
      native = await prepared.open({
        sessionId,
        mode: fork ? "fork" : previous ? "resume" : "new",
        ...(fork ? { fork: fork.target } : previous ? { nativeId: previous.nativeId } : {}),
      });
      checkConfiguration();
      prepared.validateWorkspace?.();
      if (this.stopped) throw new Error("runtime_closed");
      if (fork && (!native.nativeId || native.nativeId === fork.source.nativeId))
        throw Error("fork_identity_unavailable");
      if (!fork && previous && native.nativeId !== previous.nativeId)
        throw new Error("resume_identity_changed");
      worker = new RuntimeWorker({
        store: this.options.store,
        session: native,
        sessionId,
        threadId,
        agentId: profile.id,
        redactor,
        estimate: prepared.estimate,
        ...(prepared.firstTurnBrowser ? { firstTurnBrowser: prepared.firstTurnBrowser } : {}),
        ...(prepared.firstTurnKnowledge ? { firstTurnKnowledge: prepared.firstTurnKnowledge } : {}),
        onTurn: (id) => {
          prepared.onTurn?.(id);
          if (!id)
            setImmediate(() => {
              for (const other of this.entries.values())
                if (other.sessionId !== sessionId) void other.worker.wake();
            });
        },
        ...(prepared.fixedInjectedTokens !== undefined
          ? { fixedInjectedTokens: prepared.fixedInjectedTokens }
          : {}),
        publish: this.options.publish,
        interaction: (event, paths) => this.interaction(threadId, sessionId, event, paths),
        heldInteractionIds: () => this.engine?.heldRequestIds() ?? [],
        onCleanupFailure: () => {
          if (native) this.failedHandles.set(threadId, native);
        },
        ...(this.options.stream ? { stream: this.options.stream } : {}),
        ...(this.options.onError ? { onError: this.options.onError } : {}),
      });
      this.entries.set(threadId, {
        sessionId,
        ...(approvalRoot ? { approvalRoot } : {}),
        worker,
        native,
        redactor,
        privateValues,
      });
      worker.start();
      return worker;
    } catch (error) {
      if (error instanceof Error && error.message === "auth_required")
        claimManifestOpen(
          this.options.store,
          sessionId,
          prepared.configuration,
          this.options.publish,
          false,
        );
      try {
        if (worker) await worker.close();
        else await native?.close();
      } catch {
        if (native) this.failedHandles.set(threadId, native);
        this.options.onError?.("runtime_cleanup_failed");
      }
      this.commit((snapshot, context) => {
        const row = snapshot.session?.find((row) => row.id === sessionId);
        if (!row || ["closed", "failed"].includes(String(row.state)))
          return { events: [], result: {} };
        const outcome = handle(
          snapshot,
          { type: "transition", kind: "session", id: sessionId, to: "failed" },
          context,
        );
        return {
          ...outcome,
          events: outcome.events.map((event) => ({
            ...event,
            payload: {
              ...(event.payload as Record<string, unknown>),
              endedAt: context.at,
              endReason: this.failedHandles.has(threadId)
                ? "runtime_cleanup_required"
                : error instanceof Error &&
                    ["auth_required", ...runtimeCapabilityErrors].includes(error.message)
                  ? error.message
                  : "runtime_open_failed",
            },
          })),
        };
      });
      throw new Error(
        error instanceof Error &&
          [
            "runtime_closed",
            "resume_identity_changed",
            "auth_required",
            ...runtimeCapabilityErrors,
            "runtime_configuration_changed",
            "runtime_workspace_changed",
          ].includes(error.message)
          ? error.message
          : "runtime_open_failed",
      );
    }
  }
  streamItems(): Record<string, unknown>[] {
    return [...this.entries.values()].flatMap((entry) => entry.worker.streamItems());
  }
  async stopUnattended(threadId: string): Promise<void> {
    // Permission expiry uses the same definitive process-close boundary as interaction timeouts.
    await this.entries.get(threadId)?.worker.close("interaction_timeout");
  }
  interrupt(threadId: string, turnId: string, commandId: string): Promise<{ ok: true }> {
    const pending = this.interrupting.get(commandId);
    if (pending)
      return pending.threadId === threadId && pending.turnId === turnId
        ? pending.work
        : Promise.reject(new Error("command_receipt_conflict"));
    const work = this.track(this.performInterrupt(threadId, turnId, commandId));
    this.interrupting.set(commandId, { threadId, turnId, work });
    const settled = () => this.interrupting.delete(commandId);
    void work.then(settled, settled);
    return work;
  }
  /** Close waits for native commands already sent, so their outcome is recorded. */
  track<T>(work: Promise<T>): Promise<T> {
    this.commands.add(work);
    const settled = () => this.commands.delete(work);
    void work.then(settled, settled);
    return work;
  }
  /** The live native session for a session row, only while its thread still runs it. */
  live(sessionId: string): { threadId: string; native: AgentSession; worker: RuntimeWorker } {
    const owned = [...this.entries].find(([, entry]) => entry.sessionId === sessionId);
    if (this.stopped || !owned) throw new Error("runtime_session_unavailable");
    this.assertMutable(owned[0]);
    return { threadId: owned[0], native: owned[1].native, worker: owned[1].worker };
  }
  private async performInterrupt(
    threadId: string,
    turnId: string,
    commandId: string,
  ): Promise<{ ok: true }> {
    const previous = this.options.store.receipt<Record<string, unknown>>(commandId);
    if (previous) {
      if (
        previous.result?.kind !== "interrupt" ||
        previous.result.threadId !== threadId ||
        previous.result.turnId !== turnId
      )
        throw new Error("command_receipt_conflict");
      const note = this.options.store.snapshot().item?.find((row) => row.id === previous.result.id);
      if ((note?.body as Record<string, unknown> | undefined)?.state === "uncertain")
        throw new Error("interrupt_delivery_uncertain");
      return { ok: true };
    }
    if (this.stopped) throw new Error("runtime_closed");
    const entry = this.entries.get(threadId);
    if (!entry) throw new Error("runtime_session_unavailable");
    const id = randomUUID(),
      before = this.options.store.lastSeq();
    this.options.store.dispatch(commandId, (state) => {
      const requested = requestTurnInterrupt(state, threadId, turnId, id, {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "human", id: "local-owner" },
      });
      if (requested.result.sessionId !== entry.sessionId)
        throw new Error("runtime_session_unavailable");
      return requested;
    });
    const release = entry.worker.holdDispatch();
    this.options.publish(this.options.store.eventsSince(before));
    try {
      await entry.native.interrupt();
      this.commit((state, context) => {
        const note = state.item?.find((row) => row.id === id);
        if ((note?.body as Record<string, unknown> | undefined)?.state === "completed")
          return { events: [], result: {} };
        return handle(
          state,
          {
            type: "update",
            kind: "item",
            id,
            changes: {
              body: { ...(note?.body as Record<string, unknown>), state: "acknowledged" },
            },
          },
          context,
        );
      });
      return { ok: true };
    } catch {
      const observed = this.options.store.snapshot().item?.find((row) => row.id === id);
      if ((observed?.body as Record<string, unknown> | undefined)?.state === "completed")
        return { ok: true };
      this.commit((state, context) => {
        const note = state.item?.find((row) => row.id === id);
        if ((note?.body as Record<string, unknown> | undefined)?.state === "completed")
          return { events: [], result: {} };
        return handle(
          state,
          {
            type: "update",
            kind: "item",
            id,
            changes: {
              body: {
                ...(note?.body as Record<string, unknown>),
                state: "uncertain",
                text: "Stopping could not be confirmed. Review the native session before continuing.",
              },
            },
          },
          context,
        );
      });
      try {
        await entry.worker.close("interrupt_delivery_uncertain");
      } catch {
        this.failedHandles.set(threadId, entry.native);
        this.options.onError?.("runtime_cleanup_failed");
      }
      throw new Error("interrupt_delivery_uncertain");
    } finally {
      release();
    }
  }
  compact(
    sessionId: string,
    instructions: string | undefined,
    commandId: string,
  ): Promise<{ ok: true }> {
    return this.track(this.performCompact(sessionId, instructions, commandId));
  }
  private async performCompact(
    sessionId: string,
    instructions: string | undefined,
    commandId: string,
  ): Promise<{ ok: true }> {
    const previous = this.options.store.receipt<Record<string, unknown>>(commandId);
    if (previous) {
      if (previous.result?.kind !== "compact" || previous.result.sessionId !== sessionId)
        throw new Error("command_receipt_conflict");
      const item = this.options.store.snapshot().item?.find((row) => row.id === previous.result.id);
      if ((item?.body as Record<string, unknown> | undefined)?.state === "uncertain")
        throw new Error("compaction_delivery_uncertain");
      return { ok: true };
    }
    if (this.stopped) throw new Error("runtime_closed");
    const entry = [...this.entries.values()].find((entry) => entry.sessionId === sessionId);
    if (entry)
      this.assertMutable(String(this.options.store.record("session", sessionId)?.threadId));
    if (!entry) throw new Error("runtime_session_unavailable");
    const id = randomUUID(),
      attempt = randomUUID(),
      before = this.options.store.lastSeq();
    let produced = false;
    this.options.store.dispatch(commandId, (state) => {
      produced = true;
      return requestNativeCompaction(state, sessionId, id, attempt, {
        commandId,
        at: new Date().toISOString(),
        actor: { kind: "human", id: "local-owner" },
      });
    });
    if (!produced) return { ok: true };
    this.options.publish(this.options.store.eventsSince(before));
    try {
      await entry.native.compact(instructions);
      this.commit((state, context) =>
        settleNativeCompaction(state, id, attempt, "acknowledged", context),
      );
      void entry.worker.wake();
      return { ok: true };
    } catch {
      const item = this.options.store.snapshot().item?.find((row) => row.id === id);
      if ((item?.body as Record<string, unknown> | undefined)?.state === "completed")
        return { ok: true };
      this.commit((state, context) =>
        settleNativeCompaction(state, id, attempt, "uncertain", context),
      );
      try {
        await entry.worker.close();
      } catch {
        for (const [threadId, owned] of this.entries)
          if (owned === entry) this.failedHandles.set(threadId, entry.native);
        this.options.onError?.("runtime_cleanup_failed");
      }
      throw new Error("compaction_delivery_uncertain");
    }
  }
  /** Human confirmed disconnection: close only the exact session that received credentials. */
  async stopSession(sessionId: string): Promise<void> {
    const target = this.options.store.record("session", sessionId);
    if (target) this.forks.assertNotLeased(String(target.threadId));
    for (const [threadId, entry] of this.entries) {
      const session = this.options.store.record("session", sessionId);
      if (session?.threadId !== threadId || entry.sessionId !== sessionId) continue;
      await entry.worker.close();
      if (this.entries.get(threadId) === entry) this.entries.delete(threadId);
      return;
    }
    const session = this.options.store.record("session", sessionId);
    if (session && !["closed", "failed"].includes(String(session.state)))
      throw new Error("connection_session_not_owned");
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.stopped = true;
      await Promise.allSettled([...this.opening.values()]);
      const closed = await Promise.allSettled(
        [...this.entries.values()]
          .map((entry) => entry.worker.close())
          .concat([...this.failedHandles.values()].map((native) => native.close())),
      );
      await Promise.allSettled([...this.commands]);
      await this.privateContexts?.settle();
      this.entries.clear();
      this.failedHandles.clear();
      if (closed.some((result) => result.status === "rejected"))
        throw new Error("runtime_close_failed");
    })();
    return this.closing;
  }
}
