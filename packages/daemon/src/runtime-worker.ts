import { createHash, randomUUID } from "node:crypto";
import { type AgentSession, materializeImages } from "@zoltbot/adapters-sdk";
import {
  applyEvents,
  type CommandContext,
  claimQueuedInput,
  type DomainState,
  enforceInjectionBudget,
  handle,
  type InjectionFragment,
  linkQueuedInputTurn,
  type Outcome,
  observeRuntimeEvent,
  recordUsage,
  rejectQueuedInput,
  reserveRuntimeItem,
  settleQueuedInput,
} from "@zoltbot/core";
import {
  type AgentEvent,
  AgentEventSchema,
  type DomainEvent,
  parse,
  QueuedInputBodySchema,
  type SessionEndReason,
  type UsageSample,
} from "@zoltbot/protocol";
import type { ItemScope, Store } from "@zoltbot/store";
import { outputFragments } from "./artifacts/output.js";
import { prepareRevisionTarget, revisionTarget } from "./artifacts/revision-target.js";
import { chiefFragments } from "./chief/digest.js";
import { companyFragments } from "./company-context.js";
import { bindManifestNative } from "./connections-delivery.js";
import { withCopiedContext } from "./copied-fork-context.js";
import { forkWorkspaceBusy } from "./fork-workspaces.js";
import type { Redactor } from "./logging.js";
import { firstNativePromptPending } from "./runtime-configuration.js";
import { dispatchControlPending, rejectChangedWake } from "./runtime-dispatch.js";
import { redactRuntimeEvent } from "./runtime-redaction.js";

export interface RuntimeStream {
  threadId: string;
  turnId: string;
  itemId: string;
  kind: "message" | "thought";
  text: string;
  complete: boolean;
  item?: Record<string, unknown>;
}
interface Options {
  store: Store;
  session: Pick<AgentSession, "events" | "send" | "close">;
  sessionId: string;
  threadId: string;
  agentId: string;
  redactor: Redactor;
  estimate(text: string): number;
  fixedInjectedTokens?: number;
  firstTurnBrowser?: { text: string; bindingId: string; digest: string };
  firstTurnKnowledge?: { packId: string; text: string; tokens: number };
  fragments?: readonly InjectionFragment[];
  baseline?: UsageSample;
  publish(events: DomainEvent[]): void;
  stream?(update: RuntimeStream): void;
  /** Display-safe event plus temporary native path evidence. Never persist the second argument. */
  interaction?(
    event: Extract<AgentEvent, { t: "interaction.requested" | "interaction.cleared" }>,
    approvalSourcePaths?: readonly string[],
  ): void | Promise<void>;
  heldInteractionIds?(): readonly string[];
  onTurn?(turnId: string | undefined): void;
  onCleanupFailure?(): void;
  onError?(code: string, diagnostic?: { frames: string[] }): void;
}
interface Pending {
  id: string;
  attempt: string;
  injectedTokens: number;
}
/** One owned native session. All durable writes use the store's fenced command path. */
export class RuntimeWorker {
  private reader: Promise<void> | undefined;
  private draining: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private stopped = false;
  private cleanupFailed = false;
  private dirty = false;
  private dispatchHolds = 0;
  private pending: Pending | undefined;
  private currentTurn: string | undefined;
  private readonly text = new Map<string, string>();
  private readonly partial = new Map<string, Record<string, unknown>>();
  private readonly injected = new Map<string, number>();
  private readonly items = new Map<string, string>();
  private readonly nativeInteractions = new Map<string, string>();
  private readonly nativeTurns = new Map<string, string>();
  constructor(private readonly options: Options) {
    const state = options.store.snapshot();
    const session = state.session?.find((row) => row.id === options.sessionId);
    if (
      !session ||
      session.threadId !== options.threadId ||
      !["starting", "ready"].includes(String(session.state))
    )
      throw new Error("runtime_session_unavailable");
    if (
      state.item?.some(
        (row) =>
          row.threadId === options.threadId &&
          row.kind === "user" &&
          this.body(row.body)?.queueState === "uncertain",
      )
    )
      throw new Error("runtime_input_review_required");
  }
  private body(value: unknown) {
    try {
      return parse(QueuedInputBodySchema, value);
    } catch {
      return undefined;
    }
  }
  private context(commandId: string): CommandContext {
    return { commandId, at: new Date().toISOString(), actor: { kind: "system", id: "runtime" } };
  }
  private commit(
    produce: (state: DomainState, context: CommandContext) => Outcome,
    items?: ItemScope,
  ) {
    const commandId = `runtime:${randomUUID()}`,
      before = this.options.store.lastSeq();
    let produced = false;
    const receipt = this.options.store.dispatch(
      commandId,
      (state) => {
        produced = true;
        return produce(state, this.context(commandId));
      },
      items ? { items } : {},
    );
    if (produced) this.options.publish(this.options.store.eventsSince(before));
    return { produced, result: receipt.result };
  }
  private identity(kind: string, native: string) {
    return createHash("sha256")
      .update(JSON.stringify([this.options.sessionId, kind, native]))
      .digest("hex");
  }
  private itemIdentity(native: string, turnId?: string): string {
    if (turnId) {
      const id = this.identity("item", JSON.stringify([turnId, native]));
      this.items.set(native, id);
      return id;
    }
    const id = this.items.get(native);
    if (id) return id;
    if (!this.currentTurn) throw new Error("runtime_turn_missing");
    return this.itemIdentity(native, this.currentTurn);
  }
  /** The provider's own id for a turn this worker started, for native commands such as rewind. */
  nativeTurnId(turnId: string): string | undefined {
    return this.nativeTurns.get(turnId);
  }
  nativeInteractionId(id: string): string {
    const native = this.nativeInteractions.get(id);
    if (!native) throw new Error("runtime_interaction_missing");
    return native;
  }
  start() {
    if (this.reader || this.stopped) return;
    this.reader = this.read().catch(async (error) => {
      const frames =
        error instanceof Error
          ? (error.stack
              ?.split("\n")
              .slice(1)
              .filter((line) => /^\s+at /.test(line))
              .slice(0, 8) ?? [])
          : [];
      this.options.onError?.("runtime_event_failed", { frames });
      await this.stopNative("runtime_event_failed");
    });
  }
  private async read() {
    for await (const raw of this.options.session.events()) {
      if (this.stopped) break;
      await this.consume(parse(AgentEventSchema, raw));
    }
    if (!this.stopped) await this.stopNative("runtime_stream_ended");
  }
  private async consume(raw: AgentEvent) {
    let event = structuredClone(raw);
    if (event.t === "status" && ["error", "auth_required"].includes(event.state)) {
      await this.stopNative(
        event.state === "auth_required" ? "auth_required" : "runtime_process_error",
      );
      return;
    }
    if ("turnId" in event && event.turnId) {
      const native = event.turnId;
      event.turnId = this.identity("turn", native);
      if (event.t === "turn.started") this.nativeTurns.set(event.turnId, native);
    }
    if (event.t === "interaction.requested") {
      const activeTurn =
        this.currentTurn &&
        this.options.store
          .snapshot()
          .turn?.some((row) => row.id === this.currentTurn && row.status === "running")
          ? this.currentTurn
          : undefined;
      const native = event.interaction.id;
      const id = this.identity(
        "interaction",
        JSON.stringify([
          event.interaction.turnId ? this.identity("turn", event.interaction.turnId) : activeTurn,
          native,
        ]),
      );
      this.nativeInteractions.set(id, native);
      event.interaction = {
        ...event.interaction,
        id,
        agentId: this.options.agentId,
        threadId: this.options.threadId,
        ...(event.interaction.turnId
          ? { turnId: this.identity("turn", event.interaction.turnId) }
          : activeTurn
            ? { turnId: activeTurn }
            : {}),
      };
    }
    if (event.t === "interaction.requested" || event.t === "interaction.cleared") {
      if (!this.options.interaction) throw new Error("runtime_interaction_host_required");
      const approvalSourcePaths =
        event.t === "interaction.requested" && event.interaction.type === "approval"
          ? event.interaction.context?.paths?.slice()
          : undefined;
      const safe = redactRuntimeEvent(event, this.options.redactor);
      if (safe.t === "interaction.requested" || safe.t === "interaction.cleared")
        await this.options.interaction(safe, approvalSourcePaths);
      return;
    }
    if (event.t === "text.delta" || event.t === "thought.delta") {
      const itemId = this.itemIdentity(event.itemId, event.turnId);
      let row = this.partial.get(itemId);
      if (!row) {
        const reserved = this.commit(
          (state, context) =>
            reserveRuntimeItem(
              state,
              { sessionId: this.options.sessionId, threadId: this.options.threadId, itemId, event },
              context,
            ),
          { ids: [itemId], latestInThread: this.options.threadId },
        );
        if (!reserved.result.item) return;
        row = reserved.result.item as Record<string, unknown>;
        this.partial.set(itemId, row);
      }
      const text = (this.text.get(itemId) ?? "") + event.text;
      this.text.set(itemId, text);
      this.options.stream?.({
        threadId: this.options.threadId,
        turnId: event.turnId,
        itemId,
        kind: event.t === "text.delta" ? "message" : "thought",
        text: this.options.redactor.streamText(text),
        complete: false,
        item: {
          ...row,
          body: {
            ...(row.body as Record<string, unknown>),
            text: this.options.redactor.streamText(text),
          },
        },
      });
      return;
    }
    event = redactRuntimeEvent(event, this.options.redactor);
    if (event.t === "background.updated" && event.task.toolItemId !== undefined) {
      // Link to the Zoltbot tool item only when this worker saw the native tool start.
      const toolItemId = this.items.get(event.task.toolItemId);
      event.task = { ...event.task };
      if (toolItemId) event.task.toolItemId = toolItemId;
      else delete event.task.toolItemId;
    }
    if (event.t === "usage.updated") {
      const turnId = event.turnId ?? this.currentTurn;
      if (!turnId) return;
      // Native resume can report the previous turn's usage before starting a new turn.
      // Keep those counters out of this execution instead of attributing or replaying them.
      const owner = this.options.store.record("turn", turnId);
      if (owner?.sessionId !== this.options.sessionId || owner.threadId !== this.options.threadId)
        return;
      const sample = event.usage;
      this.commit((state, context) =>
        recordUsage(
          state,
          {
            sessionId: this.options.sessionId,
            turnId,
            sample,
            ...(this.options.baseline ? { baseline: this.options.baseline } : {}),
            injectedTokens: this.injected.get(turnId) ?? 0,
          },
          context,
        ),
      );
      return;
    }
    const itemId =
      "itemId" in event
        ? this.itemIdentity(event.itemId, "turnId" in event ? event.turnId : undefined)
        : event.t === "plan.updated"
          ? this.identity("plan", event.turnId)
          : event.t === "compaction" && event.state === "done"
            ? this.identity("compaction", randomUUID())
            : undefined;
    const pending = event.t === "turn.started" ? this.pending : undefined;
    const written = this.commit(
      (state, context) => {
        if (event.t === "session.ready")
          bindManifestNative(this.options.store, state, this.options.sessionId, event.nativeId);
        const output = observeRuntimeEvent(
          state,
          {
            sessionId: this.options.sessionId,
            threadId: this.options.threadId,
            event,
            ...(pending
              ? {
                  origin:
                    this.body(state.item?.find((row) => row.id === pending.id)?.body)?.origin ??
                    "human",
                }
              : {}),
            ...(itemId ? { itemId } : {}),
            ...(this.currentTurn ? { turnId: this.currentTurn } : {}),
            ...(this.options.heldInteractionIds
              ? { heldInteractionIds: this.options.heldInteractionIds() }
              : {}),
          },
          context,
        );
        if (event.t === "turn.started") {
          for (const row of output.events) {
            if (row.aggregateType === "turn")
              row.payload = {
                ...(row.payload as Record<string, unknown>),
                nativeTurnId: this.nativeTurns.get(event.turnId),
              };
          }
        }
        if (event.t !== "turn.started" || !pending || !output.result.started) return output;
        const linked = linkQueuedInputTurn(
          applyEvents(state, output.events),
          pending.id,
          pending.attempt,
          event.turnId,
          context,
        );
        const linkedEvents = [...output.events, ...linked.events];
        const usage = recordUsage(
          applyEvents(state, linkedEvents),
          {
            sessionId: this.options.sessionId,
            turnId: event.turnId,
            sample: {},
            injectedTokens: pending.injectedTokens,
          },
          context,
        );
        return {
          events: [...linkedEvents, ...usage.events].map((row, index) => ({
            ...row,
            eventId: `${context.commandId}:${index}`,
          })),
          result: output.result,
        };
      },
      event.t === "turn.started" && pending ? { ids: [pending.id] } : undefined,
    );
    if (written.result.ignored) return;
    if (event.t === "turn.started") {
      this.items.clear();
      this.currentTurn = event.turnId;
      this.options.onTurn?.(event.turnId);
      if (pending) {
        this.injected.set(event.turnId, pending.injectedTokens);
        this.pending = undefined;
      }
    }
    if (event.t === "message.done" || event.t === "thought.done") {
      const id = this.itemIdentity(event.itemId, "turnId" in event ? event.turnId : undefined);
      this.text.delete(id);
      this.partial.delete(id);
      this.options.stream?.({
        threadId: this.options.threadId,
        turnId: event.turnId,
        itemId: id,
        kind: event.t === "message.done" ? "message" : "thought",
        text: event.text,
        complete: true,
      });
    }
    if (event.t === "turn.done") {
      this.options.onTurn?.(undefined);
      this.text.clear();
      this.partial.clear();
    }
    if (
      event.t === "session.ready" ||
      event.t === "capabilities.updated" ||
      event.t === "turn.done" ||
      event.t === "turn.started" ||
      (event.t === "compaction" && event.state === "done")
    )
      void this.wake();
  }
  holdDispatch(): () => void {
    this.dispatchHolds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dispatchHolds--;
      if (!this.stopped) void this.wake();
    };
  }
  wake(): Promise<void> {
    this.dirty = true;
    if (!this.draining)
      this.draining = this.drain()
        .catch(async () => {
          this.options.onError?.("runtime_dispatch_failed");
          await this.stopNative("runtime_dispatch_failed");
        })
        .finally(() => {
          this.draining = undefined;
          if (this.dirty && !this.stopped) void this.wake();
        });
    return this.draining;
  }
  private dispatchBlocked(state: DomainState): boolean {
    if (
      this.pending ||
      this.dispatchHolds ||
      forkWorkspaceBusy(state, this.options.threadId, this.options.sessionId)
    )
      return true;
    return dispatchControlPending(state, this.options.threadId, this.options.sessionId);
  }
  private async drain() {
    while (this.dirty && !this.stopped) {
      this.dirty = false;
      const state = this.options.store.runtimeSnapshot(this.options.threadId);
      if (this.dispatchBlocked(state)) return;
      const session = state.session?.find((row) => row.id === this.options.sessionId);
      if (!session || !["ready", "running"].includes(String(session.state))) return;
      const busy = session.state === "running";
      const candidate = (state.item ?? [])
        .filter((row) => row.threadId === this.options.threadId && row.kind === "user")
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .find((row) => {
          const body = this.body(row.body);
          return (
            body?.queueState === "queued" &&
            (!busy ||
              (body.mode === "steer" &&
                (session.capabilities as Record<string, unknown>).steer === "native"))
          );
        });
      if (!candidate) return;
      const body = parse(QueuedInputBodySchema, candidate.body);
      let targetFragment: InjectionFragment | undefined;
      if (body.artifactTarget) {
        try {
          if (body.mode !== "queue") throw Error("artifact_target_queue_required");
          targetFragment = await prepareRevisionTarget(
            this.options.store,
            this.options.threadId,
            body.artifactTarget,
            this.options.sessionId,
          );
        } catch {
          if (
            this.body(this.options.store.record("item", String(candidate.id))?.body)?.queueState ===
            "queued"
          )
            this.commit((snapshot, context) =>
              rejectQueuedInput(snapshot, String(candidate.id), context),
            );
          this.dirty = true;
          continue;
        }
      }
      const firstNativeTurn = firstNativePromptPending(
        state,
        this.options.threadId,
        String(session.nativeId ?? ""),
      );
      let planned: ReturnType<typeof enforceInjectionBudget>;
      try {
        planned = enforceInjectionBudget({
          human: body.input,
          fragments: [
            ...(this.options.fragments ?? []),
            ...outputFragments(this.options.store, this.options.sessionId, candidate, body),
            ...chiefFragments(this.options.store, this.options.threadId),
            ...companyFragments(this.options.store, this.options.threadId),
            ...(targetFragment ? [targetFragment] : []),
          ],
          firstTurn: firstNativeTurn,
          fixedInjectedTokens: firstNativeTurn ? (this.options.fixedInjectedTokens ?? 0) : 0,
          estimate: this.options.estimate,
        });
        if (firstNativeTurn && this.options.firstTurnBrowser)
          planned.input.push({ type: "text", text: this.options.firstTurnBrowser.text });
        if (firstNativeTurn && this.options.firstTurnKnowledge?.text) {
          // Exact frozen bytes in the first user input only. No system prompt mutation or replay.
          planned.estimatedTokens += this.options.firstTurnKnowledge.tokens;
          if (planned.estimatedTokens > 1500) throw new Error("injection_budget_exceeded");
          planned.input.push({ type: "text", text: this.options.firstTurnKnowledge.text });
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (!["injection_fixed_budget_exceeded", "injection_budget_exceeded"].includes(code))
          throw error;
        this.commit((snapshot, context) =>
          handle(
            snapshot,
            {
              type: "create",
              kind: "item",
              value: {
                id: randomUUID(),
                threadId: this.options.threadId,
                kind: "note",
                seq:
                  (snapshot.item ?? []).reduce(
                    (highest, row) =>
                      row.threadId === this.options.threadId
                        ? Math.max(highest, Number(row.seq))
                        : highest,
                    0,
                  ) + 1,
                body: {
                  code: "injection_budget_exceeded",
                  text: "Generated context exceeds this session's token budget. Your message is still queued.",
                },
                createdAt: context.at,
                updatedAt: context.at,
              },
            },
            context,
          ),
        );
        await this.stopNative("injection_budget_exceeded");
        return;
      }
      let nativeInput = withCopiedContext(this.options, firstNativeTurn, planned.input);
      if (nativeInput.some((part) => part.type === "image")) {
        try {
          if ((session.capabilities as Record<string, unknown>).images !== true)
            throw new Error("unsupported_images");
          nativeInput = await materializeImages(nativeInput);
        } catch {
          if (this.stopped) return;
          if (
            this.body(this.options.store.record("item", String(candidate.id))?.body)?.queueState !==
            "queued"
          ) {
            this.dirty = true;
            continue;
          }
          this.commit((snapshot, context) => {
            const rejected = rejectQueuedInput(snapshot, String(candidate.id), context);
            const next = applyEvents(snapshot, rejected.events);
            const note = handle(
              next,
              {
                type: "create",
                kind: "item",
                value: {
                  id: randomUUID(),
                  threadId: this.options.threadId,
                  kind: "note",
                  seq:
                    (next.item ?? []).reduce(
                      (n, row) =>
                        row.threadId === this.options.threadId ? Math.max(n, Number(row.seq)) : n,
                      0,
                    ) + 1,
                  body: {
                    code: "attachment_invalid",
                    inputId: candidate.id,
                    text: "An image could not be loaded, is unsupported, or exceeds the native input limit. This message was not sent.",
                  },
                  createdAt: context.at,
                  updatedAt: context.at,
                },
              },
              context,
            );
            return {
              events: [...rejected.events, ...note.events].map((event, index) => ({
                ...event,
                eventId: `${context.commandId}:${index}`,
              })),
              result: rejected.result,
            };
          });
          this.dirty = true;
          continue;
        }
      }
      const currentQueue = this.options.store.runtimeSnapshot(this.options.threadId);
      if (this.stopped || this.dispatchBlocked(currentQueue)) return;
      if (
        this.body(currentQueue.item?.find((row) => row.id === candidate.id)?.body)?.queueState !==
        "queued"
      ) {
        this.dirty = true;
        continue;
      }
      if (rejectChangedWake(currentQueue, candidate, (work) => this.commit(work))) {
        this.dirty = true;
        continue;
      }
      if (body.artifactTarget) {
        try {
          revisionTarget(
            this.options.store,
            this.options.threadId,
            body.artifactTarget,
            this.options.sessionId,
          );
        } catch {
          this.commit((snapshot, context) =>
            rejectQueuedInput(snapshot, String(candidate.id), context),
          );
          this.dirty = true;
          continue;
        }
      }
      const attempt = randomUUID(),
        id = String(candidate.id);
      const claimed = this.commit(
        (snapshot, context) =>
          claimQueuedInput(
            snapshot,
            id,
            this.options.sessionId,
            attempt,
            context,
            firstNativeTurn && this.options.firstTurnBrowser
              ? {
                  bindingId: this.options.firstTurnBrowser.bindingId,
                  digest: this.options.firstTurnBrowser.digest,
                }
              : undefined,
          ),
        { ids: [id] },
      );
      if (!claimed.produced) return;
      const steering = claimed.result.deliveryMode === "steer",
        turnId = steering ? this.currentTurn : undefined;
      const pending = { id, attempt, injectedTokens: planned.estimatedTokens };
      if (!steering) this.pending = pending;
      try {
        const receipt = await this.options.session.send(nativeInput, steering ? "steer" : "queue");
        const current = this.options.store.record("item", id);
        if (this.body(current?.body)?.queueState === "sending")
          this.commit(
            (snapshot, context) =>
              settleQueuedInput(
                snapshot,
                id,
                attempt,
                {
                  state: receipt.disposition === "handled" ? "handled" : "sent",
                  ...(turnId && receipt.disposition !== "handled" ? { turnId } : {}),
                },
                context,
              ),
            { ids: [id] },
          );
        if (receipt.disposition === "handled" && this.pending === pending) this.pending = undefined;
        if (steering && turnId)
          this.injected.set(turnId, (this.injected.get(turnId) ?? 0) + planned.estimatedTokens);
      } catch {
        const current = this.options.store.record("item", id);
        if (this.body(current?.body)?.queueState === "sending") {
          this.commit(
            (snapshot, context) =>
              settleQueuedInput(
                snapshot,
                id,
                attempt,
                { state: "uncertain", errorCode: "delivery_uncertain" },
                context,
              ),
            { ids: [id] },
          );
          await this.stopNative("delivery_uncertain");
          return;
        }
      }
      this.dirty = true;
    }
  }
  private async stopNative(code: SessionEndReason) {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.options.session.close();
    } catch {
      this.cleanupFailed = true;
      this.options.onCleanupFailure?.();
      this.options.onError?.("runtime_cleanup_failed");
    } finally {
      this.commit((state, context) => {
        const session = state.session?.find((row) => row.id === this.options.sessionId);
        if (!session || ["closed", "failed"].includes(String(session.state)))
          return { events: [], result: {} };
        const turn = state.turn?.find(
          (row) => row.sessionId === session.id && row.status === "running",
        );
        const output = turn
          ? observeRuntimeEvent(
              state,
              {
                sessionId: this.options.sessionId,
                threadId: this.options.threadId,
                event: { t: "turn.done", turnId: turn.id, status: "interrupted", stopReason: code },
                synthetic: true,
                ...(this.options.heldInteractionIds
                  ? { heldInteractionIds: this.options.heldInteractionIds() }
                  : {}),
              },
              context,
            )
          : { events: [], result: {} };
        const next = handle(
          applyEvents(state, output.events),
          {
            type: "transition",
            kind: "session",
            id: this.options.sessionId,
            to: "closed",
          },
          context,
        );
        return {
          events: [
            ...output.events,
            ...next.events.map((row) => ({
              ...row,
              payload: {
                ...(row.payload as Record<string, unknown>),
                endedAt: context.at,
                endReason: this.cleanupFailed ? "runtime_cleanup_required" : code,
              },
            })),
          ].map((row, index) => ({
            ...row,
            eventId: `${context.commandId}:${index}`,
          })),
          result: {},
        };
      });
      this.text.clear();
      this.partial.clear();
    }
  }
  streamItems(): Record<string, unknown>[] {
    return [...this.partial].map(([id, row]) => ({
      ...row,
      body: {
        ...(row.body as Record<string, unknown>),
        text: this.options.redactor.streamText(this.text.get(id) ?? ""),
      },
    }));
  }
  close(
    reason:
      | "runtime_closed"
      | "interaction_timeout"
      | "interrupt_delivery_uncertain"
      | "interaction_delivery_uncertain" = "runtime_closed",
  ): Promise<void> {
    this.closing ??= (async () => {
      await this.stopNative(reason);
      await this.draining;
      await this.reader;
      if (this.cleanupFailed) throw new Error("runtime_cleanup_required");
    })();
    return this.closing;
  }
}
