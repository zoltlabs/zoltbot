import { createHash, randomUUID } from "node:crypto";
import {
  answerInteractions,
  applyRuleAnswer,
  type CommandContext,
  type DomainState,
  deferInteraction,
  expireInteractions,
  forwardLateAnswer,
  handle,
  type LateAnswerInput,
  type Outcome,
  requestInteraction,
  timeoutInteraction,
} from "@zoltbot/core";
import {
  type ActorRef,
  assertNoPrivateValue,
  type DomainEvent,
  type Interaction,
  type InteractionAnswer,
  InteractionDraftSchema,
  InteractionSchema,
  parse,
  publicAnswerData,
  type UserInput,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

export interface InteractionHost {
  /** Resolve every target against the owned native session cwd. Never trust renderer flags. */
  approvalPaths?(
    interaction: Interaction,
    sourcePaths?: readonly string[],
  ): readonly string[] | undefined;
  /** Register in the session redactor and activate private frame mode before native reply. */
  registerSecret(value: string, interaction: Interaction): void;
  persistPrivateContext?(interaction: Interaction): Promise<void>;
  preparePublicAnswer?(
    interaction: Interaction,
    answer: InteractionAnswer,
  ): Promise<(state: DomainState) => void>;
  prepareInput?(input: UserInput): Promise<(state: DomainState) => void>;
  requiresSecretReply(interaction: Interaction): boolean;
  saveSecret?(
    value: unknown,
    interaction: Interaction,
    itemId: string,
  ): Promise<{ reference: string }>;
  respond(interaction: Interaction, answer: InteractionAnswer): Promise<void>;
  /** Resolve only after the native turn has stopped, using process close if needed. */
  stopTurn?(interaction: Interaction): Promise<void>;
}
type AnswerInput = { id: string; version: number; answer: InteractionAnswer };
export class InteractionEngine {
  private readonly knownPrivateValues = new Set<string>();
  private readonly active = new Set<string>();
  private readonly ruleWork = new Set<Promise<void>>();
  private readonly answerWork = new Set<Promise<Interaction[]>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  constructor(
    private readonly options: {
      store: Store;
      host?: InteractionHost;
      prepareInput?(input: UserInput): Promise<(state: DomainState) => void>;
      preparePublicAnswer?(
        request: Interaction,
        answer: InteractionAnswer,
      ): Promise<(state: DomainState) => void>;
      rememberPrivateValue?(value: string): void;
      publish(events: DomainEvent[]): void;
      now?: () => string;
      onError?: (code: string) => void;
      onQueued?: (threadId: string) => void;
    },
  ) {}
  private context(commandId: string, actor: ActorRef): CommandContext {
    return { commandId, actor, at: this.options.now?.() ?? new Date().toISOString() };
  }
  private commit(commandId: string, produce: (state: DomainState) => Outcome) {
    let produced = false;
    const before = this.options.store.lastSeq();
    const receipt = this.options.store.dispatch(commandId, (state) => {
      produced = true;
      return produce(state);
    });
    if (produced) this.options.publish(this.options.store.eventsSince(before));
    return { result: receipt.result, produced };
  }
  request(
    input: unknown,
    commandId: string,
    actor: ActorRef = { kind: "system", id: "runtime" },
    approvalSourcePaths?: readonly string[],
  ) {
    const draft = parse(InteractionDraftSchema, input);
    const output = this.commit(commandId, (state) =>
      requestInteraction(state, draft, randomUUID(), this.context(commandId, actor)),
    );
    const interaction = parse(InteractionSchema, output.result);
    if (interaction.id !== draft.id) throw new Error("command_receipt_conflict");
    if (output.produced && interaction.type === "approval" && this.options.host) {
      const ruleCommand = `rule:${createHash("sha256").update(commandId).digest("hex")}`;
      const work = this.applyRules(
        interaction,
        ruleCommand,
        approvalSourcePaths ? Object.freeze([...approvalSourcePaths]) : undefined,
      ).catch(() => this.options.onError?.("interaction_rule_failed"));
      this.ruleWork.add(work);
      void work.then(
        () => this.ruleWork.delete(work),
        () => this.ruleWork.delete(work),
      );
    }
    return interaction;
  }
  private async applyRules(
    request: Interaction,
    commandId: string,
    approvalSourcePaths?: readonly string[],
  ) {
    const host = this.options.host;
    if (!host || this.active.has(request.id)) return;
    // Native tools execute within the captured ceiling. Any request returned by the provider
    // needs the human; a saved reusable host rule cannot widen an unattended routine.
    if (
      (this.options.store.snapshot(["task"]).task ?? []).some(
        (task) => task.threadId === request.threadId && task.routineOccurrenceId,
      )
    )
      return;
    const context = this.context(commandId, { kind: "system", id: "rules" });
    if (
      !applyRuleAnswer(
        this.options.store.snapshot(),
        request.id,
        context,
        host.approvalPaths?.(request, approvalSourcePaths),
      ).result.matched
    )
      return;
    this.active.add(request.id);
    try {
      const output = this.commit(commandId, (state) =>
        applyRuleAnswer(
          state,
          request.id,
          context,
          host.approvalPaths?.(request, approvalSourcePaths),
        ),
      );
      if (!output.produced || !output.result.matched) return;
      const resolved = parse(InteractionSchema, output.result.interaction);
      if (!resolved.resolution) throw new Error("interaction_resolution_missing");
      try {
        await host.respond(request, resolved.resolution);
      } catch {
        this.replyFailed(request);
      }
    } finally {
      this.active.delete(request.id);
    }
  }
  clear(
    threadIds: readonly string[],
    reason: "process_died" | "turn_ended" | "provider_cleared",
    commandId: string,
    sessionId?: string,
  ) {
    return this.commit(commandId, (state) =>
      expireInteractions(
        state,
        threadIds,
        reason,
        this.context(commandId, { kind: "system", id: "runtime" }),
        sessionId,
      ),
    ).result;
  }
  heldRequestIds(): readonly string[] {
    return [...this.active];
  }
  clearRequests(
    ids: readonly string[],
    reason: "process_died" | "turn_ended" | "provider_cleared",
    commandId: string,
  ) {
    const selected = new Set(ids);
    return this.commit(commandId, (state) => {
      const interaction = (state.interaction ?? []).filter(
        (row) => selected.has(String(row.id)) && !this.active.has(String(row.id)),
      );
      return expireInteractions(
        { ...state, interaction },
        [...new Set(interaction.map((row) => String(row.threadId)))],
        reason,
        this.context(commandId, { kind: "system", id: "runtime" }),
      );
    }).result;
  }
  async answer(
    id: string,
    version: number,
    answer: InteractionAnswer,
    commandId: string,
    actor: ActorRef,
    check?: (state: DomainState) => void,
  ) {
    const results = await this.batch([{ id, version, answer }], commandId, actor, check);
    const result = results[0];
    if (!result || result.id !== id) throw new Error("command_receipt_conflict");
    return result;
  }
  private replay(commandId: string): Interaction[] | undefined {
    const receipt = this.options.store.receipt<Record<string, unknown>>(commandId);
    if (!receipt) return undefined;
    if (!Array.isArray(receipt.result.results)) throw new Error("command_receipt_conflict");
    return receipt.result.results.map((row) => parse(InteractionSchema, row));
  }
  private register(value: unknown, interaction: Interaction, host: InteractionHost) {
    const pending = [value];
    let visited = 0;
    while (pending.length) {
      if (++visited > 10000) throw new Error("secret_value_too_large");
      const current = pending.pop();
      if (
        typeof current === "string" ||
        typeof current === "number" ||
        typeof current === "boolean"
      ) {
        this.knownPrivateValues.add(String(current));
        this.options.rememberPrivateValue?.(String(current));
        host.registerSecret(String(current), interaction);
      } else if (current && typeof current === "object") pending.push(...Object.values(current));
    }
  }
  batch(
    input: readonly AnswerInput[],
    commandId: string,
    actor: ActorRef,
    check?: (state: DomainState) => void,
  ): Promise<Interaction[]> {
    const work = this.performBatch(input, commandId, actor, check);
    this.answerWork.add(work);
    void work.then(
      () => this.answerWork.delete(work),
      () => this.answerWork.delete(work),
    );
    return work;
  }
  private async performBatch(
    input: readonly AnswerInput[],
    commandId: string,
    actor: ActorRef,
    check?: (state: DomainState) => void,
  ): Promise<Interaction[]> {
    if (!check && input.some((item) => item.answer.via)) throw Error("view_context_required");
    const replay = this.replay(commandId);
    if (replay) return replay;
    const host = this.options.host;
    if (!host) throw new Error("interaction_runtime_unavailable");
    const context = this.context(commandId, actor);
    const original = structuredClone(input);
    for (const item of original) {
      item.answer.by = actor;
      item.answer.at = context.at;
      if (actor.kind === "human") delete item.answer.automatic;
    }
    const items = structuredClone(original);
    const state = this.options.store.snapshot();
    answerInteractions(state, original, context);
    if (items.some((item) => this.active.has(item.id))) throw new Error("interaction_conflict");
    for (const item of items) this.active.add(item.id);
    try {
      const requests = items.map((item) =>
        parse(
          InteractionSchema,
          state.interaction?.find((row) => row.id === item.id),
        ),
      );
      const privateRequests = new Set<Interaction>();
      for (let index = 0; index < items.length; index++) {
        const item = items[index],
          interaction = requests[index];
        if (!item || !interaction) throw new Error("interaction_not_found");
        item.answer.by = actor;
        item.answer.at = context.at;
        if (actor.kind === "human") delete item.answer.automatic;
        for (const field of interaction.items) {
          if (
            !field.secret ||
            !item.answer.answers ||
            !Object.hasOwn(item.answer.answers, field.id)
          )
            continue;
          const secret = item.answer.answers[field.id];
          privateRequests.add(interaction);
          try {
            this.register(secret, interaction, host);
          } catch {
            throw new Error("secret_registration_failed");
          }
          if (!host.requiresSecretReply(interaction)) {
            if (!host.saveSecret) throw new Error("secret_storage_unavailable");
            try {
              const saved = await host.saveSecret(secret, interaction, field.id);
              item.answer.answers[field.id] = { value: saved.reference };
            } catch {
              throw new Error("secret_storage_failed");
            }
          }
        }
      }
      for (const [index, request] of requests.entries()) {
        const answer = original[index]?.answer;
        if (answer)
          assertNoPrivateValue(publicAnswerData(request, answer), this.knownPrivateValues);
      }
      for (const request of privateRequests) {
        try {
          await host.persistPrivateContext?.(request);
        } catch {
          throw new Error("secret_storage_failed");
        }
      }
      const checks: ((state: DomainState) => void)[] = [];
      for (const [index, request] of requests.entries()) {
        const answer = original[index]?.answer;
        if (answer && this.options.preparePublicAnswer)
          checks.push(await this.options.preparePublicAnswer(request, answer));
        else if (answer && host.preparePublicAnswer)
          checks.push(await host.preparePublicAnswer(request, answer));
      }
      const output = this.commit(commandId, (state) => {
        check?.(state);
        for (const check of checks) check(state);
        for (const [index, request] of requests.entries()) {
          const answer = original[index]?.answer;
          if (answer)
            assertNoPrivateValue(publicAnswerData(request, answer), this.knownPrivateValues);
        }
        return answerInteractions(state, original, context);
      });
      const results = this.replay(commandId);
      if (!results) throw new Error("command_receipt_missing");
      if (output.produced)
        for (let index = 0; index < items.length; index++) {
          const item = items[index],
            request = requests[index];
          if (!item || !request) continue;
          try {
            await host.respond(request, item.answer);
          } catch {
            this.replyFailed(request);
          }
        }
      return results;
    } finally {
      for (const item of items) this.active.delete(item.id);
    }
  }
  private replyFailed(interaction: Interaction) {
    const commandId = `reply-failure:${randomUUID()}`;
    const context = this.context(commandId, { kind: "system", id: "runtime" });
    this.commit(commandId, (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "item",
          value: {
            id: randomUUID(),
            threadId: interaction.threadId,
            kind: "note",
            seq:
              (state.item ?? []).reduce(
                (highest, item) =>
                  item.threadId === interaction.threadId
                    ? Math.max(highest, Number(item.seq))
                    : highest,
                0,
              ) + 1,
            body: {
              code: "interaction_reply_failed",
              interactionId: interaction.id,
              text: "Your answer was saved, but delivery was not confirmed. Review the native session before forwarding it as a message.",
            },
            createdAt: context.at,
            updatedAt: context.at,
          },
        },
        context,
      ),
    );
  }
  forwardLate(input: LateAnswerInput, commandId: string, actor: ActorRef) {
    const perform = (check?: (state: DomainState) => void) => {
      const output = this.commit(commandId, (state) => {
        check?.(state);
        assertNoPrivateValue([input.text], this.knownPrivateValues);
        return forwardLateAnswer(state, input, randomUUID(), this.context(commandId, actor));
      });
      if (output.produced) {
        const row = this.options.store.snapshot().item?.find((row) => row.id === output.result.id);
        if (typeof row?.threadId === "string") this.options.onQueued?.(row.threadId);
      }
      return output.result;
    };
    if (this.options.store.receipt(commandId)) return perform();
    const inputParts: UserInput = [{ type: "text", text: input.text }];
    const prepared = this.options.prepareInput
      ? this.options.prepareInput(inputParts)
      : this.options.host?.prepareInput?.(inputParts);
    return prepared ? prepared.then(perform) : perform();
  }

  defer(id: string, commandId: string, actor: ActorRef) {
    this.commit(commandId, (state) => deferInteraction(state, id, this.context(commandId, actor)));
    return { ok: true };
  }
  startTimers() {
    if (this.timer) return;
    if (!this.options.host?.stopTurn) throw new Error("interaction_runtime_incomplete");
    this.timer = setInterval(() => {
      void this.tick().catch(() => this.options.onError?.("interaction_timeout_failed"));
    }, 1000);
    this.timer.unref();
  }
  async stopTimers() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => {});
    await Promise.allSettled([...this.ruleWork, ...this.answerWork]);
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.tickDue().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private async tickDue() {
    const host = this.options.host;
    if (!host) return;
    const now = Date.parse(this.options.now?.() ?? new Date().toISOString());
    if (!Number.isFinite(now)) return;
    let failure: Error | undefined;
    for (const row of this.options.store.snapshot().interaction ?? []) {
      if (row.state !== "pending" || !row.timeout) continue;
      const request = parse(InteractionSchema, row);
      const deadline = Date.parse(request.createdAt) + (request.timeout?.seconds ?? 0) * 1000;
      if (!Number.isFinite(deadline) || now < deadline || this.active.has(request.id)) continue;
      const commandId = `timeout:${createHash("sha256")
        .update(JSON.stringify([request.id, request.version]))
        .digest("hex")}`;
      if (this.options.store.receipt(commandId)) continue;
      this.active.add(request.id);
      try {
        const context = this.context(commandId, { kind: "system", id: "timeouts" });
        const planned = timeoutInteraction(this.options.store.snapshot(), request.id, context);
        if (planned.result.action === "park") {
          if (!host.stopTurn) throw new Error("interaction_stop_unavailable");
          try {
            await host.stopTurn(request);
          } catch {
            throw new Error("interaction_stop_failed");
          }
        }
        const output = this.commit(commandId, (state) =>
          timeoutInteraction(state, request.id, context),
        );
        if (output.produced && output.result.action === "answer") {
          const resolved = parse(InteractionSchema, output.result.interaction);
          if (!resolved.resolution) throw new Error("interaction_resolution_missing");
          try {
            await host.respond(request, resolved.resolution);
          } catch {
            this.replyFailed(request);
          }
        }
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error("interaction_timeout_failed");
      } finally {
        this.active.delete(request.id);
      }
    }
    if (failure) throw failure;
  }
}
