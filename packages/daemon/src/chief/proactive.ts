import { randomUUID } from "node:crypto";
import { applyEvents, type DomainState, handle, queueSystemNotice } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { inQuietHours } from "../notifications.js";
import { briefMessage, briefState, briefVerdict } from "./brief.js";
import {
  type ChiefState,
  chiefKeys,
  chiefName,
  chiefNotes,
  chiefThreadId,
  chiefWakePrefix,
  setting,
  settingCommand,
} from "./identity.js";
import { chiefInbox } from "./inbox.js";
import { chiefQueue, lessonCandidates, queueCandidates, settleQueue } from "./queue.js";

// Zolt wakes itself, rarely, when it has work only it can do.
// Everything here is decided from records with no model call: which signals are open, whether a
// turn is worth it, and afterwards whether that turn left something the person can use.

export interface ChiefProactive {
  enabled: boolean;
  maxTurnsPerDay: number;
  minGapMinutes: number;
  quietHoursFollowNotifications: boolean;
}
export const proactiveDefaults: ChiefProactive = {
  enabled: true,
  maxTurnsPerDay: 5,
  minGapMinutes: 90,
  quietHoursFollowNotifications: true,
};
const minute = 60_000;
/** A burst of signals becomes one turn. */
export const coalesceMs = 10 * minute;
/** If the person used the app this recently, they will see it themselves. */
export const activeMs = 10 * minute;
/** A tracked chat with no activity this long while running counts as stuck. */
export const stuckMs = 30 * minute;
/** Wasted wake-ups in a row that halve the day's allowance. */
export const wastedLimit = 3;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const clamp = (value: unknown, low: number, high: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(high, Math.max(low, Math.round(value)))
    : fallback;

export function proactiveConfig(state: ChiefState): ChiefProactive {
  const value = (setting(state, chiefKeys.proactive) ?? {}) as Partial<ChiefProactive>;
  return {
    enabled: value.enabled !== false,
    maxTurnsPerDay: clamp(value.maxTurnsPerDay, 0, 12, proactiveDefaults.maxTurnsPerDay),
    minGapMinutes: clamp(value.minGapMinutes, 30, 24 * 60, proactiveDefaults.minGapMinutes),
    quietHoursFollowNotifications: value.quietHoursFollowNotifications !== false,
  };
}

export interface ChiefWakeState {
  /** Local calendar day the counts belong to. */
  day: string;
  used: number;
  /** Wasted wake-ups in a row; at `wastedLimit` the allowance halves until one is useful. */
  wasted: number;
  lastWakeAt?: string;
  /** The wake-up whose turn has not been judged yet. */
  pending?: { itemId: string; at: string };
  /** Today's judged wake-ups, for "1 of 2 useful". */
  results: { at: string; useful: boolean }[];
}
export const localDay = (at: number) => new Date(at).toLocaleDateString("en-CA");
export function wakeState(state: ChiefState, now: number): ChiefWakeState {
  const value = (setting(state, chiefKeys.wake) ?? {}) as Partial<ChiefWakeState>;
  const day = localDay(now);
  const same = value.day === day;
  return {
    day,
    used: same && typeof value.used === "number" ? value.used : 0,
    wasted: typeof value.wasted === "number" ? value.wasted : 0,
    ...(value.lastWakeAt ? { lastWakeAt: value.lastWakeAt } : {}),
    ...(value.pending ? { pending: value.pending } : {}),
    results: same && Array.isArray(value.results) ? value.results.slice(-24) : [],
  };
}
export function allowance(config: ChiefProactive, wake: ChiefWakeState): number {
  return wake.wasted >= wastedLimit
    ? Math.max(1, Math.floor(config.maxTurnsPerDay / 2))
    : config.maxTurnsPerDay;
}

export type ChiefSignalKind = "needs_you" | "failed" | "question" | "stuck";
export interface ChiefSignal {
  id: string;
  kind: ChiefSignalKind;
  at: string;
  text: string;
}

/** When the chief last had a turn: anything older reached it already, in a digest or a wake-up. */
function lastSeen(state: ChiefState, chief: string): string {
  return (state.turn ?? [])
    .filter((row) => row.threadId === chief)
    .reduce((latest, row) => (text(row.startedAt) > latest ? text(row.startedAt) : latest), "");
}
/** Chats Zolt started or keeps a note on. */
function tracked(state: ChiefState): Set<string> {
  const notes = chiefNotes(state).chats;
  return new Set(
    (state.thread ?? [])
      .filter(
        (row) => !row.archived && (text(row.id).startsWith("chief-chat-") || notes[text(row.id)]),
      )
      .map((row) => text(row.id)),
  );
}

/** Open signals that can wake Zolt. Digest-only events never appear here. */
export function chiefSignals(state: ChiefState, now: number): ChiefSignal[] {
  const chief = chiefThreadId(state);
  if (!chief) return [];
  const since = lastSeen(state, chief);
  const triage = chiefQueue(state).items;
  const titles = new Map(
    (state.thread ?? []).map((row) => [text(row.id), text(row.title) || "a chat"]),
  );
  const signals: ChiefSignal[] = [];
  for (const row of queueCandidates(state))
    if (row.threadId !== chief && !triage[text(row.id)] && text(row.createdAt) > since) {
      const items = (row.items ?? []) as { prompt?: string }[];
      const title = (text(row.title) || text(items[0]?.prompt)).replace(/\s+/g, " ").slice(0, 90);
      signals.push({
        id: `needs_you:${text(row.id)}`,
        kind: "needs_you",
        at: text(row.createdAt),
        text: `${text(row.type)} "${title}" in "${titles.get(text(row.threadId))}" (${text(row.id)}) is not triaged.`,
      });
    }
  const watched = tracked(state);
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of state.turn ?? []) {
    const id = text(row.threadId);
    if (!watched.has(id)) continue;
    const previous = latest.get(id);
    if (!previous || text(row.startedAt) > text(previous.startedAt)) latest.set(id, row);
  }
  for (const [id, turn] of latest) {
    if (turn.status === "failed" && text(turn.endedAt) > since)
      signals.push({
        id: `failed:${text(turn.id)}`,
        kind: "failed",
        at: text(turn.endedAt),
        text: `Chat "${titles.get(id)}" (${id}) failed.`,
      });
    const activity = (state.thread ?? []).find((row) => row.id === id)?.lastActivityAt;
    const stuckAt = new Date(Date.parse(text(activity)) + stuckMs).toISOString();
    if (turn.status === "running" && Date.parse(stuckAt) <= now && stuckAt > since)
      signals.push({
        id: `stuck:${id}:${text(activity)}`,
        kind: "stuck",
        at: stuckAt,
        text: `Chat "${titles.get(id)}" (${id}) has been running with no activity for 30 minutes.`,
      });
  }
  for (const entry of chiefInbox(state))
    if (entry.kind === "question" && entry.status === "new" && entry.at > since)
      signals.push({
        id: `question:${entry.id}`,
        kind: "question",
        at: entry.at,
        text: `Question from "${entry.fromTitle}" (${entry.fromThread}): ${entry.text.slice(0, 200)}`,
      });
  return signals.sort((a, b) => a.at.localeCompare(b.at));
}

export type WakeVerdict =
  | { wake: true; signals: ChiefSignal[]; brief?: true }
  | {
      wake: false;
      reason:
        | "no_chief"
        | "off"
        | "nothing"
        | "coalescing"
        | "gap"
        | "user_active"
        | "busy"
        | "quiet_hours"
        | "allowance";
    };
/** Whether a turn is worth sending now. Nothing open means nothing is sent, ever. */
export function wakeVerdict(
  state: ChiefState,
  input: { now: number; lastActive: number },
): WakeVerdict {
  const chief = chiefThreadId(state);
  if (!chief) return { wake: false, reason: "no_chief" };
  const config = proactiveConfig(state);
  if (!config.enabled || !config.maxTurnsPerDay) return { wake: false, reason: "off" };
  const signals = chiefSignals(state, input.now);
  if (!signals.length) return { wake: false, reason: "nothing" };
  if (input.now - Date.parse(signals[0]?.at ?? "") < coalesceMs)
    return { wake: false, reason: "coalescing" };
  const wake = wakeState(state, input.now);
  if (wake.lastWakeAt && input.now - Date.parse(wake.lastWakeAt) < config.minGapMinutes * minute)
    return { wake: false, reason: "gap" };
  if (input.now - input.lastActive < activeMs) return { wake: false, reason: "user_active" };
  if (
    wake.pending ||
    (state.turn ?? []).some((row) => row.threadId === chief && row.status === "running")
  )
    return { wake: false, reason: "busy" };
  const notifications = setting(state, "notifications") as { quietHours?: unknown } | undefined;
  if (config.quietHoursFollowNotifications && inQuietHours(notifications?.quietHours, input.now))
    return { wake: false, reason: "quiet_hours" };
  if (wake.used >= allowance(config, wake)) return { wake: false, reason: "allowance" };
  return { wake: true, signals };
}

/** One message listing everything still open, and what a useful turn leaves behind. */
export function wakeMessage(state: ChiefState, signals: ChiefSignal[]): string {
  const name = chiefName(state);
  const lessons = lessonCandidates(chiefQueue(state));
  const groups: [ChiefSignalKind, string][] = [
    ["needs_you", "New for the user"],
    ["failed", "Failed"],
    ["stuck", "Stuck"],
    ["question", "Questions to you"],
  ];
  const lines = [`[Zoltbot] ${name}, this is a wake-up, not a message from the user.`];
  for (const [kind, title] of groups) {
    const rows = signals.filter((signal) => signal.kind === kind);
    if (rows.length) lines.push(`${title}:`, ...rows.slice(0, 12).map((row) => `- ${row.text}`));
  }
  for (const lesson of lessons.slice(0, 2))
    lines.push(
      `The user overruled you ${lesson.count} times on ${lesson.kind}: ${lesson.examples.join("; ")}. Propose one preference with chief_learn, citing ${lesson.evidence.join(", ")}.`,
    );
  lines.push(
    "Leave something the user can use: triage new items with chief_triage (a recommendation, and a draft where a reply is needed), propose a fix or a nudge for failed or stuck chats, or promote a good idea. If nothing needs doing, end the turn without writing to the user. Do not report status; they check back on their own. Never call chief_answer here.",
  );
  return lines.join("\n");
}

/** What the turn after a wake-up left behind: triage, a proposed action or idea, or a lesson. */
export function usefulSince(state: ChiefState, chief: string, since: string): boolean {
  if (Object.values(chiefQueue(state).items).some((triage) => triage.at >= since)) return true;
  if (
    (state.interaction ?? []).some((row) => row.threadId === chief && text(row.createdAt) >= since)
  )
    return true;
  return (state.knowledgeProposal ?? []).some(
    (row) => row.threadId === chief && text(row.createdAt) >= since,
  );
}

export interface ChiefWakerOptions {
  store: Store;
  publish(events: DomainEvent[]): void;
  wake(threadId: string): Promise<void>;
  now?: () => number;
  intervalMs?: number;
  onError?: (code: string) => void;
}
export function chiefWaker(options: ChiefWakerOptions) {
  const now = options.now ?? Date.now;
  // At start the person has the app open, so the first wake-up waits for them to step away.
  let lastActive = now();
  let running: Promise<unknown> | undefined;
  const kinds = [
    "settings",
    "thread",
    "turn",
    "interaction",
    "project",
    "subproject",
    "knowledgeProposal",
  ] as const;

  function dispatch(commandId: string, build: (state: DomainState) => { events: DomainEvent[] }) {
    const before = options.store.lastSeq();
    options.store.dispatch(commandId, (state) => ({ ...build(state), result: {} }));
    options.publish(options.store.eventsSince(before));
  }
  const system = { kind: "system" as const, id: "chief-waker" };
  /** Settle outcomes and judge the last wake-up. Runs whether or not wake-ups are on. */
  function settle(at: number) {
    const state = options.store.snapshot([...kinds]);
    const chief = chiefThreadId(state);
    if (!chief) return;
    const iso = new Date(at).toISOString();
    const queue = settleQueue(state, iso);
    if (queue) {
      const commandId = `chief-settle:${randomUUID()}`;
      dispatch(commandId, (current) =>
        handle(
          current,
          settingCommand(current, chiefKeys.queue, settleQueue(current, iso) ?? queue),
          {
            commandId,
            at: iso,
            actor: system,
          },
        ),
      );
    }
    const wake = wakeState(state, at);
    if (!wake.pending) return;
    const item = options.store.record("item", wake.pending.itemId);
    const body = (item?.body ?? {}) as { queueState?: unknown };
    const started = (state.turn ?? []).filter(
      (row) => row.threadId === chief && text(row.startedAt) >= (wake.pending?.at ?? ""),
    );
    // A wake-up that never started (the runtime was down) stops blocking after two hours.
    const failed =
      !item ||
      body.queueState === "failed" ||
      (!started.length && at - Date.parse(wake.pending.at) > 120 * minute);
    const ended =
      started.length > 0 &&
      body.queueState !== "queued" &&
      started.every((row) => row.status !== "running");
    if (!failed && !ended) return;
    // A brief is useful when Zolt wrote one; a wake-up when it left something to act on.
    const brief = wake.pending.itemId.startsWith(`${chiefWakePrefix}brief:`);
    const useful =
      !failed &&
      (brief
        ? (options.store.snapshot(["item"]).item ?? []).some(
            (row) =>
              row.threadId === chief &&
              row.kind === "message" &&
              text(row.createdAt) >= (wake.pending?.at ?? ""),
          )
        : usefulSince(state, chief, wake.pending.at));
    const next: ChiefWakeState = {
      ...wake,
      wasted: failed ? wake.wasted : useful ? 0 : wake.wasted + 1,
      results: failed ? wake.results : [...wake.results, { at: iso, useful }],
    };
    delete next.pending;
    const commandId = `chief-judge:${wake.pending.itemId}`;
    if (options.store.receipt(commandId)) return;
    dispatch(commandId, (current) =>
      handle(current, settingCommand(current, chiefKeys.wake, next), {
        commandId,
        at: iso,
        actor: system,
      }),
    );
  }
  /** Closes today's brief without sending one: nothing happened, or it is too late. */
  function skipBrief(day: string, at: string) {
    const commandId = `chief-brief-skip:${day}`;
    if (options.store.receipt(commandId)) return;
    dispatch(commandId, (current) =>
      handle(current, settingCommand(current, chiefKeys.brief, { day, at }), {
        commandId,
        at: new Date(now()).toISOString(),
        actor: system,
      }),
    );
  }
  async function tick(): Promise<WakeVerdict> {
    const at = now();
    settle(at);
    let state = options.store.snapshot([...kinds]);
    const brief = briefVerdict(state, at);
    if (!brief.due && brief.reason === "nothing")
      skipBrief(localDay(at), new Date(at).toISOString());
    if (!brief.due && brief.reason === "stale")
      skipBrief(localDay(at), briefState(state).at ?? new Date(at).toISOString());
    if (!brief.due && (brief.reason === "nothing" || brief.reason === "stale"))
      state = options.store.snapshot([...kinds]);
    const verdict: WakeVerdict = brief.due
      ? { wake: true, signals: [], brief: true }
      : wakeVerdict(state, { now: at, lastActive });
    if (!verdict.wake) return verdict;
    const chief = chiefThreadId(state) as string;
    const iso = new Date(at).toISOString();
    const wake = wakeState(state, at);
    const itemId = brief.due
      ? `${chiefWakePrefix}brief:${wake.day}`
      : `${chiefWakePrefix}${wake.day}:${wake.used + 1}:${randomUUID().slice(0, 8)}`;
    const commandId = `chief-wake:${itemId}`;
    if (options.store.receipt(commandId)) return verdict;
    dispatch(commandId, (current) => {
      const queued = queueSystemNotice(
        current,
        {
          threadId: chief,
          text: brief.due
            ? briefMessage(current, brief.facts)
            : wakeMessage(current, verdict.signals),
        },
        itemId,
        { commandId, at: iso, actor: system },
      );
      const next: ChiefWakeState = {
        ...wake,
        used: wake.used + 1,
        lastWakeAt: iso,
        pending: { itemId, at: iso },
      };
      const saved = handle(
        applyEvents(current, queued.events),
        settingCommand(current, chiefKeys.wake, next),
        { commandId: `${commandId}:state`, at: iso, actor: system },
      );
      const day = brief.due
        ? handle(
            applyEvents(applyEvents(current, queued.events), saved.events),
            settingCommand(current, chiefKeys.brief, { day: wake.day, at: iso }),
            { commandId: `${commandId}:brief`, at: iso, actor: system },
          ).events
        : [];
      return {
        events: [...queued.events, ...saved.events, ...day].map((event, index) => ({
          ...event,
          eventId: `${commandId}:${index}`,
        })),
      };
    });
    try {
      await options.wake(chief);
    } catch {
      options.onError?.("chief_wake_failed");
    }
    return verdict;
  }
  const timer = setInterval(() => {
    if (running) return;
    running = tick()
      .catch(() => options.onError?.("chief_tick_failed"))
      .finally(() => {
        running = undefined;
      });
  }, options.intervalMs ?? minute);
  timer.unref?.();
  return {
    tick,
    /** The person used the app: sent something, answered, or opened a chat. */
    active() {
      lastActive = now();
    },
    close() {
      clearInterval(timer);
    },
  };
}
export type ChiefWaker = ReturnType<typeof chiefWaker>;
