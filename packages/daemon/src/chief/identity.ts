import type { Command, DomainState } from "@zoltbot/core";
import type { Store } from "@zoltbot/store";

// The main agent above every workspace. Code says "chief"; the name people
// see is a setting, so renaming it never touches code, tools or stored keys.

export const chiefKeys = {
  name: "chief.name",
  thread: "chief.thread",
  notes: "chief.notes",
  /** Triage and outcomes for Needs you items (phase 2b, 2c). Written only by the daemon. */
  queue: "chief.queue",
  /** Wake-up bookkeeping (2a). Written only by the daemon. */
  wake: "chief.wake",
  /** The day the morning brief last went out or was skipped. Written only by the daemon. */
  brief: "chief.brief",
  /** Ideas, updates and questions leads send up (2d). Written only by the daemon. */
  inbox: "chief.inbox",
  /** Wake-ups Zolt set for itself. Written only by the daemon. */
  timers: "chief.timers",
  /** The person's proactive settings; clients may write it. */
  proactive: "chief.proactive",
} as const;
/** Keys clients may never write through `settings.set`. */
export const reservedChiefKeys: ReadonlySet<string> = new Set([
  chiefKeys.notes,
  chiefKeys.queue,
  chiefKeys.wake,
  chiefKeys.inbox,
  chiefKeys.brief,
  chiefKeys.timers,
]);
export const defaultChiefName = "Zolt";

/** Any snapshot: the daemon store hands out partial ones. */
export type ChiefState = Partial<DomainState>;
export function setting(state: ChiefState, key: string): unknown {
  return state.settings?.find((row) => row.key === key)?.value;
}
export function chiefName(state: ChiefState): string {
  const value = setting(state, chiefKeys.name);
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 40) : defaultChiefName;
}
/** The chief's thread, only while it is a live chat outside every workspace. */
export function chiefThreadId(state: ChiefState): string | undefined {
  const id = setting(state, chiefKeys.thread);
  if (typeof id !== "string") return undefined;
  const thread = state.thread?.find((row) => row.id === id);
  return thread && !thread.archived && !thread.projectId && !thread.fork && !thread.taskId
    ? id
    : undefined;
}
export function isChief(store: Pick<Store, "snapshot">, threadId: string): boolean {
  return chiefThreadId(store.snapshot(["settings", "thread"])) === threadId;
}

export interface ChiefNote {
  text: string;
  at: string;
}
export interface ChiefNotes {
  summary?: ChiefNote;
  chats: Record<string, ChiefNote>;
}
export function chiefNotes(state: ChiefState): ChiefNotes {
  const value = setting(state, chiefKeys.notes) as Partial<ChiefNotes> | undefined;
  return {
    ...(value?.summary ? { summary: value.summary } : {}),
    chats: value?.chats && typeof value.chats === "object" ? value.chats : {},
  };
}

/** Fixed per session (T2). A rename reaches the model when its next session starts. */
export function chiefInstructions(name: string): string {
  return [
    `You are ${name}, the user's main agent in Zoltbot: chief of staff across their workspaces.`,
    "Use the live status block, chief_overview and chief_read_chat to inspect work. Keep chief_note summaries current. Finished turns are not accepted outcomes.",
    "Use company_work describe/read/propose for organization, initiative and task plans; the human reviews them in the workspace. Assign within applied authority. Respect existing structure; small fixes and direct chats need no manager or initiative. Workspace tools create teams and managers with approval where required.",
    "chief_start_chat/message_chat/stop_chat request individual approval. Wait for outcomes. Briefs must be self-contained; execute in workspace chats.",
    "Triage Needs you, recommend and draft answers. chief_answer only relays decisions the human stated, with confirmation; never decide for them. Promote useful lead ideas, drop noise, propose evidence-backed preferences with chief_learn.",
    "Supervise commitments, blockers and results within approved scope. Escalate scope, budget or permission changes. Save evidence-backed project briefs; suggest reorgs from observed friction.",
    "On autonomous wakes, only chief_notify reaches the human, except morning briefs. Doing nothing is fine. Use chief_wake_later for follow-up.",
  ].join("\n");
}

/** One line for workspace managers, so ideas reach the main agent without being asked for. */
export const leadIdeasInstruction =
  'When you finish a piece of work and noticed something worth doing outside your brief (a risk, a simplification, a feature users would want), send it with team_message to: "chief", idea: true, in one or two lines with why. At most three a day; send only your best.';

/** Create-or-update for a daemon-owned settings row. */
export function settingCommand(state: ChiefState, key: string, value: unknown): Command {
  return state.settings?.some((row) => row.key === key)
    ? { type: "update", kind: "settings", id: key, changes: { value } }
    : { type: "create", kind: "settings", value: { key, value } };
}

/** Item ids of wake-up notices, so the chat can show them as events and tools can tell them apart. */
export const chiefWakePrefix = "chief-wake:";
/** Whether the chief's latest delivered input is the person's own message, not a notice. */
export function startedByUser(store: Pick<Store, "runtimeSnapshot">, threadId: string): boolean {
  const delivered = (store.runtimeSnapshot(threadId).item ?? [])
    .filter(
      (row) =>
        row.threadId === threadId &&
        row.kind === "user" &&
        !["queued", "failed"].includes(String((row.body as { queueState?: unknown })?.queueState)),
    )
    .sort((a, b) => Number(b.seq) - Number(a.seq))[0];
  if (!delivered) return false;
  const body = delivered.body as { origin?: unknown; sourceInteractionId?: unknown };
  return (
    !String(delivered.id).startsWith(chiefWakePrefix) &&
    !body.sourceInteractionId &&
    body.origin !== "agent" &&
    body.origin !== "system"
  );
}
