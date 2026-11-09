import { type ChiefState, chiefKeys, chiefName, chiefThreadId, setting } from "./identity.js";
import { chiefInbox } from "./inbox.js";
import { allowance, localDay, proactiveConfig, wakeState } from "./proactive.js";
import { chiefQueue, queueCandidates } from "./queue.js";

// The morning brief: once a day at a time you pick, Zolt writes you a short brief. Off until you
// turn it on. It counts against the day's wake-ups and is skipped when nothing happened.

export interface ChiefBriefConfig {
  enabled: boolean;
  /** Local "HH:MM". */
  time: string;
}
export const briefDefaults: ChiefBriefConfig = { enabled: false, time: "08:30" };
/** A brief this late is stale; the day's brief is skipped instead. */
export const briefWindowMs = 4 * 3_600_000;

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function briefConfig(state: ChiefState): ChiefBriefConfig {
  const value = (setting(state, chiefKeys.proactive) as { brief?: Partial<ChiefBriefConfig> })
    ?.brief;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(text(value?.time))
    ? text(value?.time)
    : briefDefaults.time;
  return { enabled: value?.enabled === true, time };
}
/** The day the last brief was sent or skipped, and when. */
export function briefState(state: ChiefState): { day?: string; at?: string } {
  const value = setting(state, chiefKeys.brief) as { day?: unknown; at?: unknown } | undefined;
  return {
    ...(text(value?.day) ? { day: text(value?.day) } : {}),
    ...(text(value?.at) ? { at: text(value?.at) } : {}),
  };
}
/** Today's brief time, as a timestamp in local time. */
export function briefTime(config: ChiefBriefConfig, now: number): number {
  const [hours, minutes] = config.time.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours ?? 8, minutes ?? 30, 0, 0);
  return at.getTime();
}

/** What happened since the last brief (or the last day), in lines Zolt can write from. */
export function briefFacts(state: ChiefState, since: string): string[] {
  const chief = chiefThreadId(state);
  const titles = new Map(
    (state.thread ?? []).map((row) => [text(row.id), text(row.title) || "a chat"]),
  );
  const ended = new Map<string, string>();
  for (const turn of state.turn ?? []) {
    const id = text(turn.threadId);
    if (id === chief || text(turn.endedAt) < since) continue;
    if (turn.status === "completed" || turn.status === "failed")
      ended.set(id, turn.status === "failed" ? "failed" : (ended.get(id) ?? "finished"));
  }
  const waiting = queueCandidates(state).filter((row) => row.threadId !== chief);
  const triage = chiefQueue(state).items;
  const untriaged = waiting.filter((row) => !triage[text(row.id)]).length;
  const inbox = chiefInbox(state).filter((entry) => entry.status === "new");
  const lines: string[] = [];
  const finished = [...ended].filter(([, status]) => status === "finished");
  const failed = [...ended].filter(([, status]) => status === "failed");
  if (finished.length)
    lines.push(
      `Finished: ${finished
        .slice(0, 10)
        .map(([id]) => `"${titles.get(id)}" (${id})`)
        .join(", ")}${finished.length > 10 ? ` and ${finished.length - 10} more` : ""}.`,
    );
  if (failed.length)
    lines.push(
      `Failed: ${failed
        .slice(0, 10)
        .map(([id]) => `"${titles.get(id)}" (${id})`)
        .join(", ")}.`,
    );
  if (waiting.length)
    lines.push(
      `Needs the user: ${waiting.length}${untriaged ? `, ${untriaged} not triaged yet` : ""}.`,
    );
  if (inbox.length) lines.push(`From leads: ${inbox.length} not handled yet.`);
  return lines;
}

export type BriefVerdict =
  | { due: true; facts: string[] }
  | {
      due: false;
      reason: "no_chief" | "off" | "not_yet" | "sent" | "stale" | "busy" | "nothing" | "allowance";
    };
/** Whether today's brief should go out now. `nothing` and `stale` still close the day. */
export function briefVerdict(state: ChiefState, now: number): BriefVerdict {
  const chief = chiefThreadId(state);
  if (!chief) return { due: false, reason: "no_chief" };
  const config = briefConfig(state);
  if (!config.enabled) return { due: false, reason: "off" };
  const today = localDay(now);
  const last = briefState(state);
  if (last.day === today) return { due: false, reason: "sent" };
  const at = briefTime(config, now);
  if (now < at) return { due: false, reason: "not_yet" };
  if (now - at > briefWindowMs) return { due: false, reason: "stale" };
  const wake = wakeState(state, now);
  if (
    wake.pending ||
    (state.turn ?? []).some((row) => row.threadId === chief && row.status === "running")
  )
    return { due: false, reason: "busy" };
  const since =
    last.at && now - Date.parse(last.at) < 7 * 86_400_000
      ? last.at
      : new Date(now - 86_400_000).toISOString();
  const facts = briefFacts(state, since);
  if (!facts.length) return { due: false, reason: "nothing" };
  if (wake.used >= allowance(proactiveConfig(state), wake))
    return { due: false, reason: "allowance" };
  return { due: true, facts };
}

export function briefMessage(state: ChiefState, facts: string[]): string {
  return [
    `[Zoltbot] ${chiefName(state)}, this is the user's morning brief, not a message from the user.`,
    ...facts,
    "Triage anything new with chief_triage first. Then reply with the brief, which unlike other wake-ups reaches the user as written (no chief_notify): at most eight short lines, what finished or failed, what needs them in queue order with your recommendation, and the one thing you would start today. No greeting and no status filler. Never call chief_answer here.",
  ].join("\n");
}
