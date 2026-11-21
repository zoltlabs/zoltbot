import { createHash } from "node:crypto";
import {
  applyEvents,
  type DomainState,
  handle,
  type Outcome,
  queueSystemNotice,
} from "@zoltbot/core";
import {
  compareSessions,
  type DomainEvent,
  type EntityKind,
  HOST_WORKSPACE_REF,
  type InteractionDraft,
  type ModelSwitchNote,
  type Profile,
  ProfileSchema,
  parse,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { copiedContext, copiedContextKey, visibleForkHistory } from "../copied-fork-context.js";
import {
  type ActiveRecord,
  accountTitle,
  ackKey,
  activeKey,
  askedKey,
  catalogFreeModels,
  defaultAccountId,
  effectiveOrder,
  exhaustedKey,
  type LimitRecord,
  latestNativeSession,
  limitIdOf,
  limitKey,
  limitOf,
  type OrderEntry,
  setting,
} from "./records.js";

export interface BackupSupervisorHost {
  store: Store;
  publish(events: DomainEvent[]): void;
  /** Closes the chat's live session so its next turn launches on the new entry. */
  stopThread(threadId: string): Promise<void> | undefined;
  /** Changes a live session's model in place, keeping its native session. */
  setModel?(sessionId: string, model: string, commandId: string): Promise<unknown>;
  /** Records the owner's one-time ask before work moves to another provider. */
  request?(draft: InteractionDraft, commandId: string): Promise<unknown>;
  /** Starts a turn for a queued notice. */
  wake?(threadId: string): Promise<void>;
  now?(): number;
  intervalMs?: number;
  onError?(code: string): void;
}
interface Asked {
  interactionId: string;
  trigger: string;
}
const kinds: EntityKind[] = [
  "thread",
  "agent",
  "agentDefinition",
  "session",
  "turn",
  "settings",
  "interaction",
  "project",
  "task",
];
const system = { kind: "system" as const, id: "backup-models" };
const short = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
/** Work continues by itself only in chats agents drive: task and manager chats. */
const continuing = (kind: unknown) => kind === "task" || kind === "manager";
const continueText =
  "The previous turn stopped at a usage limit before it finished. Continue where you left off.";

/**
 * Moves chats to the next entry in their backup order when their account hits a usage limit,
 * and back when a higher entry is free again. Decisions read persisted state at turn
 * boundaries, so a missed tick or a restart only delays a switch.
 */
export function backupSupervisor(host: BackupSupervisorHost) {
  const { store } = host;
  const now = () => host.now?.() ?? Date.now();
  let cursor = store.lastSeq();
  let running: Promise<void> | undefined;
  let closed = false;
  const commit = (commandId: string, build: (state: DomainState) => Outcome) => {
    const before = store.lastSeq();
    store.dispatch(commandId, build);
    host.publish(store.eventsSince(before));
  };
  const settingEvents = (rows: { key: string; value: unknown }[], commandId: string, at: string) =>
    rows.map((row, index) => ({
      eventId: `${commandId}:s${index}`,
      commandId,
      aggregateType: "settings",
      aggregateId: row.key,
      type: "settings.created",
      occurredAt: at,
      payload: row,
    }));
  const profileOf = (state: DomainState, threadId: string): Profile | undefined => {
    const thread = state.thread?.find((row) => row.id === threadId);
    try {
      return parse(
        ProfileSchema,
        state.agent?.find((row) => row.id === thread?.agentId),
      );
    } catch {
      return undefined;
    }
  };
  /** The account a session ran on: the switch in force when it started, else the agent's own. */
  function accountOf(state: DomainState, session: Record<string, unknown>) {
    const threadId = String(session.threadId);
    const active = setting<ActiveRecord>(state, activeKey(threadId));
    const profile = profileOf(state, threadId);
    if (!profile) return undefined;
    if (!active) return defaultAccountId(profile.definitionId);
    if (String(session.startedAt ?? "") >= active.at)
      return active.home ? defaultAccountId(profile.definitionId) : active.accountId;
    return active.fromAccountId ?? defaultAccountId(profile.definitionId);
  }
  /** Records each account's limit from session statuses, including ones a later turn cleared. */
  function observeLimits() {
    const seen: Record<string, unknown>[] = [];
    for (;;) {
      const events = store.eventsSince(cursor, 1000);
      for (const event of events) {
        cursor = Math.max(cursor, event.seq ?? cursor);
        if (event.aggregateType === "session") seen.push(event.payload as Record<string, unknown>);
      }
      if (events.length < 1000) break;
    }
    const state = store.snapshot(kinds);
    const found = new Map<string, LimitRecord>();
    const free = catalogFreeModels(state, now());
    for (const session of [...seen, ...(state.session ?? [])]) {
      const status = session.runtimeStatus as
        | { state?: string; resetsAt?: string; observedAt?: string }
        | undefined;
      if (status?.state !== "rate_limited" || !status.observedAt) continue;
      const accountId = accountOf(state, session);
      if (!accountId) continue;
      const model = typeof session.model === "string" ? session.model : undefined;
      const key = limitKey(limitIdOf(free, accountId, model));
      const known = found.get(key) ?? setting<LimitRecord>(state, key);
      if (known && known.observedAt >= status.observedAt) continue;
      found.set(key, {
        ...(status.resetsAt ? { resetsAt: status.resetsAt } : {}),
        observedAt: status.observedAt,
        sessionId: String(session.id),
      });
    }
    const rows = [...found].map(([key, value]) => ({ key, value }));
    if (!rows.length) return;
    const commandId = `backup:limits:${short(JSON.stringify(rows))}`;
    commit(commandId, () => ({
      events: settingEvents(rows, commandId, new Date(now()).toISOString()),
      result: { ok: true },
    }));
  }
  const labelOf = (state: DomainState, accountId: string) => accountTitle(state, accountId, now());
  const note = (state: DomainState, threadId: string, body: ModelSwitchNote, at: string) =>
    handle(
      state,
      {
        type: "create",
        kind: "item",
        value: {
          id: `backup-note:${short(`${threadId}:${body.change}:${at}`)}`,
          threadId,
          kind: "note",
          seq:
            (state.item ?? []).reduce(
              (top, row) => (row.threadId === threadId ? Math.max(top, Number(row.seq)) : top),
              0,
            ) + 1,
          body,
          createdAt: at,
          updatedAt: at,
        },
      },
      { commandId: `backup:note:${threadId}:${at}`, at, actor: system },
    );
  /** The owner's answer to the one-time ask: undefined while it waits, else whether to go. */
  async function asked(
    state: DomainState,
    threadId: string,
    trigger: string,
    from: string,
    target: OrderEntry,
    until: string | undefined,
  ): Promise<boolean | undefined> {
    const thread = state.thread?.find((row) => row.id === threadId);
    const task = state.task?.find((row) => row.id === thread?.taskId);
    const projectId = String(thread?.projectId ?? task?.projectId ?? "");
    const scope = projectId || `thread:${threadId}`;
    if (setting(state, ackKey(scope))) return true;
    const previous = setting<Asked>(state, askedKey(threadId));
    if (previous?.trigger === trigger) {
      const interaction = state.interaction?.find((row) => row.id === previous.interactionId);
      if (!interaction || interaction.state === "pending") return undefined;
      const resolution = interaction.resolution as
        | { action?: string; answers?: Record<string, { options?: string[] }> }
        | undefined;
      const go =
        interaction.state === "answered" &&
        resolution?.action === "accept" &&
        resolution.answers?.choice?.options?.includes("continue") === true;
      if (go && resolution?.answers?.remember?.options?.includes("remember")) {
        const commandId = `backup:ack:${scope}`;
        commit(commandId, () => ({
          events: settingEvents(
            [{ key: ackKey(scope), value: { at: new Date(now()).toISOString() } }],
            commandId,
            new Date(now()).toISOString(),
          ),
          result: { ok: true },
        }));
      }
      return go;
    }
    if (!host.request || !thread) return false;
    const provider = target.definition.displayName;
    const project = state.project?.find((row) => row.id === projectId)?.name;
    const interactionId = `backup-${short(`${threadId}:${trigger}`)}`;
    const draft: InteractionDraft = {
      id: interactionId,
      agentId: String(thread.agentId),
      threadId,
      type: "question",
      title: `Continue on ${provider}?`,
      context: {
        toolInput: {
          backupSwitch: {
            from,
            to: labelOf(state, target.accountId),
            provider,
            ...(until ? { until } : {}),
            ...(project ? { project } : {}),
          },
        },
      },
      items: [
        {
          id: "choice",
          header: "Provider",
          prompt: `${from} is at its limit. ${labelOf(state, target.accountId)} can continue now. ${provider} will see this project's code and the conversation so far.`,
          options: [
            { id: "continue", label: `Continue on ${provider}`, recommended: true },
            { id: "wait", label: "Wait for the limit to reset" },
          ],
        },
        {
          id: "remember",
          header: "Next time",
          prompt: project ? `Don't ask again for ${project}` : "Don't ask again for this chat",
          options: [
            { id: "remember", label: "Don't ask again" },
            { id: "ask", label: "Ask next time" },
          ],
        },
      ],
      chain: [system],
      urgency: "background",
      nativeRef: HOST_WORKSPACE_REF,
    };
    const commandId = `backup:asked:${threadId}:${short(trigger)}`;
    commit(commandId, () => ({
      events: settingEvents(
        [{ key: askedKey(threadId), value: { interactionId, trigger } }],
        commandId,
        new Date(now()).toISOString(),
      ),
      result: { ok: true },
    }));
    await host.request(draft, `backup:ask:${interactionId}`);
    return undefined;
  }
  async function consider(state: DomainState, threadId: string) {
    const thread = state.thread?.find((row) => row.id === threadId && !row.archived);
    const profile = profileOf(state, threadId);
    if (!thread || !profile) return;
    if (state.turn?.some((row) => row.threadId === threadId && row.status === "running")) return;
    const at = now();
    const order = effectiveOrder(state, threadId, profile, at);
    if (order.length < 2) return;
    const active = setting<ActiveRecord>(state, activeKey(threadId));
    const current = active ?? {
      accountId: defaultAccountId(profile.definitionId),
      ...(profile.model ? { model: profile.model } : {}),
      home: true,
    };
    const same = (entry: OrderEntry) =>
      entry.accountId === current.accountId &&
      (entry.model ?? profile.model) === (current.model ?? profile.model);
    const position = order.findIndex(same);
    const latest = (state.session ?? [])
      .filter((row) => row.threadId === threadId)
      .sort(compareSessions)[0];
    const status = latest?.runtimeStatus as { state?: string; observedAt?: string } | undefined;
    const hit =
      status?.state === "rate_limited" && status.observedAt && active?.trigger !== status.observedAt
        ? status.observedAt
        : undefined;
    const freeModels = catalogFreeModels(state, at);
    const limitFor = (accountId: string, model: string | undefined) =>
      limitOf(state, limitIdOf(freeModels, accountId, model), at);
    const entryLimit = (entry: OrderEntry) =>
      limitFor(
        entry.account.id,
        entry.model ??
          (entry.accountId === defaultAccountId(profile.definitionId) ? profile.model : undefined),
      );
    const free = (entry: OrderEntry) => !entryLimit(entry) && !same(entry);
    const from = labelOf(state, current.accountId);
    const fromLimit = limitFor(current.accountId, current.model);
    let index: number;
    if (hit) {
      index = order.findIndex(free);
      if (index < 0) {
        if (setting(state, exhaustedKey(threadId)) === hit) return;
        const resets = order
          .map((entry) => entryLimit(entry)?.resetsAt)
          .filter((value): value is string => !!value)
          .sort()[0];
        const stamp = new Date(at).toISOString();
        const commandId = `backup:exhausted:${threadId}:${short(hit)}`;
        commit(commandId, (snapshot) => {
          const written = note(
            snapshot,
            threadId,
            {
              code: "model_switch",
              change: "exhausted",
              from,
              ...(resets ? { until: resets } : {}),
              text: `${from} hit its limit. No backup is free.`,
            },
            stamp,
          );
          return {
            events: [
              ...written.events,
              ...settingEvents([{ key: exhaustedKey(threadId), value: hit }], commandId, stamp),
            ],
            result: { ok: true },
          };
        });
        return;
      }
    } else {
      if (!active) return;
      index = order.findIndex((entry) => !entryLimit(entry));
      if (index < 0 || (position >= 0 && index >= position)) return;
    }
    const target = order[index] as OrderEntry;
    const change = position >= 0 && index < position ? "returned" : "switched";
    const own = state.agentDefinition?.find((row) => row.id === profile.definitionId);
    if (target.definition.adapter !== own?.adapter) {
      const trigger = `${hit ?? `return:${active?.at}`}:${target.accountId}:${target.model ?? ""}`;
      const go = await asked(state, threadId, trigger, from, target, fromLimit?.resetsAt);
      if (!go) return;
    }
    await perform(threadId, profile, current, target, {
      change,
      from,
      hit,
      until: fromLimit?.resetsAt,
    });
  }
  async function perform(
    threadId: string,
    profile: Profile,
    current: { accountId: string; model?: string },
    target: OrderEntry,
    how: {
      change: "switched" | "returned";
      from: string;
      hit?: string | undefined;
      until?: string | undefined;
    },
  ) {
    const { change, from, hit, until } = how;
    const state = store.snapshot();
    const model =
      target.model ?? (target.definition.id === profile.definitionId ? profile.model : undefined);
    const home =
      target.accountId === defaultAccountId(profile.definitionId) && model === profile.model;
    const latest = (state.session ?? [])
      .filter((row) => row.threadId === threadId)
      .sort(compareSessions)[0];
    let native = false;
    if (
      target.accountId === current.accountId &&
      model &&
      latest?.state === "ready" &&
      host.setModel
    ) {
      try {
        await host.setModel(
          String(latest.id),
          model,
          `backup:model:${threadId}:${short(String(hit ?? now()))}`,
        );
        native = true;
      } catch {
        native = false;
      }
    }
    if (!native) await host.stopThread(threadId);
    const stamp = new Date(now()).toISOString();
    const to = labelOf(state, target.accountId);
    const record: ActiveRecord = {
      accountId: target.accountId,
      ...(model ? { model } : {}),
      home,
      copied: !native,
      ...(native ? {} : { boundarySessionId: latestNativeSession(state, threadId)?.id as string }),
      ...(hit ? { trigger: hit } : {}),
      fromAccountId: current.accountId,
      at: stamp,
    };
    const thread = state.thread?.find((row) => row.id === threadId);
    const resume = !!hit && continuing(thread?.kind);
    const commandId = `backup:switch:${threadId}:${short(`${stamp}:${target.accountId}`)}`;
    commit(commandId, (snapshot) => {
      const rows: { key: string; value: unknown }[] = [{ key: activeKey(threadId), value: record }];
      if (!native)
        try {
          rows.push({
            key: copiedContextKey(threadId),
            value: copiedContext(visibleForkHistory(snapshot, threadId)),
          });
        } catch {}
      const events: DomainEvent[] = settingEvents(rows, commandId, stamp);
      let next = applyEvents(snapshot, events);
      const written = note(
        next,
        threadId,
        {
          code: "model_switch",
          change,
          from,
          to,
          ...(change === "switched" && until ? { until } : {}),
          ...(native ? {} : { copied: true }),
          text:
            change === "returned"
              ? `Back on ${to}.`
              : `${from} hit its limit. Continuing on ${to}.`,
        },
        stamp,
      );
      events.push(...written.events);
      next = applyEvents(next, written.events);
      if (resume)
        events.push(
          ...queueSystemNotice(
            next,
            { threadId, text: continueText },
            `backup-continue:${short(commandId)}`,
            { commandId: `${commandId}:continue`, at: stamp, actor: system },
          ).events,
        );
      return { events, result: { ok: true } };
    });
    if (resume) await host.wake?.(threadId).catch(() => host.onError?.("backup_wake_failed"));
  }
  async function tick() {
    if (closed) return;
    observeLimits();
    const state = store.snapshot(kinds);
    const threads = new Set<string>();
    for (const row of state.settings ?? [])
      if (String(row.key).startsWith("models.active.")) threads.add(String(row.key).slice(14));
    for (const session of state.session ?? [])
      if ((session.runtimeStatus as { state?: string } | undefined)?.state === "rate_limited")
        threads.add(String(session.threadId));
    for (const threadId of threads) {
      try {
        await consider(store.snapshot(kinds), threadId);
      } catch {
        host.onError?.("backup_switch_failed");
      }
    }
  }
  const run = () => {
    running ??= tick().finally(() => {
      running = undefined;
    });
    return running;
  };
  const timer = setInterval(() => void run(), host.intervalMs ?? 3000);
  timer.unref?.();
  return {
    tick: run,
    async close() {
      closed = true;
      clearInterval(timer);
      await running;
    },
  };
}
