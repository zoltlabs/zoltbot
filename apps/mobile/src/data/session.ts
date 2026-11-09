import { text } from "@zoltbot/ui/chat/types";
import type { Row, Snapshot } from "./transport.js";

// The live session behind a chat: its permission mode, background tasks, and the latest plan.

const ended = (session: Row) =>
  Boolean(session.endedAt) || session.state === "closed" || session.state === "failed";

/** The newest live session of a thread, else its newest one. */
export function threadSession(snapshot: Snapshot, threadId: string): Row | undefined {
  const sessions = (snapshot.entities.session ?? [])
    .filter((row) => row.threadId === threadId)
    .sort((a, b) => text(b.startedAt).localeCompare(text(a.startedAt)));
  return sessions.find((row) => !ended(row)) ?? sessions[0];
}

const modeNames: Record<string, string> = {
  default: "Ask before edits",
  acceptEdits: "Auto-accept edits",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
  auto: "Auto",
};
/** A readable name for a native mode; unknown modes are spelled out from their id. */
export function modeLabel(mode: string): string {
  const known = modeNames[mode];
  if (known) return known;
  const words = mode
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Default";
}
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
/**
 * Whether switching to a mode widens what the agent may do without asking. The adapter lists
 * the modes that never widen in capabilities.safeModes; any other mode widens, and without the
 * list every mode does (I4, I13).
 */
export function modeWidens(session: Row | undefined, mode: string): boolean {
  const capabilities = (session?.capabilities ?? {}) as Row;
  return !strings(capabilities.safeModes).includes(mode);
}

export interface ModeState {
  current: string;
  label: string;
  /** Modes the phone may switch to: only ones that never widen permission. */
  options: { mode: string; label: string }[];
  /** Modes left out because they widen permission and can only be chosen on the Mac. */
  macOnly: number;
}
/** The mode chip's state, or undefined when the session does not report selectable modes. */
export function modeState(session: Row | undefined): ModeState | undefined {
  if (!session || ended(session)) return undefined;
  const modes = strings(((session.capabilities ?? {}) as Row).modes);
  if (!modes.length) return undefined;
  const current = text(session.mode) || (modes.includes("default") ? "default" : "");
  const safe = modes.filter((mode) => !modeWidens(session, mode));
  return {
    current,
    label: current ? modeLabel(current) : "Mode",
    options: safe.map((mode) => ({ mode, label: modeLabel(mode) })),
    macOnly: modes.length - safe.length,
  };
}

/** Error text for a refused mode change; the daemon keeps widening modes on the Mac. */
export function modeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.startsWith("mac_only")) return "Change this mode on your Mac.";
  return message || "The mode could not be changed.";
}

export interface ModelState {
  sessionId: string;
  current: string;
  label: string;
  models: { id: string; name: string }[];
  /** Effort levels the agent accepts; empty when it does not take one. */
  efforts: string[];
  effort?: string;
  /** The session has run a turn, so a change drops the provider's prompt cache. */
  started: boolean;
  /** A turn is running now; it keeps its model and the change applies to the next one. */
  running: boolean;
}
/** The model chip's state, or undefined when the agent does not let you pick a model. */
export function modelState(snapshot: Snapshot, session: Row | undefined): ModelState | undefined {
  if (!session || ended(session)) return undefined;
  const capabilities = (session.capabilities ?? {}) as Row;
  const models = (capabilities.models ?? {}) as Row;
  if (models.selectable !== true) return undefined;
  const list = (Array.isArray(models.list) ? (models.list as Row[]) : [])
    .filter((row) => text(row.id))
    .map((row) => ({ id: text(row.id), name: text(row.name) || text(row.id) }));
  if (!list.length) return undefined;
  const current = text(session.model);
  const turns = (snapshot.entities.turn ?? []).filter((turn) => turn.sessionId === session.id);
  return {
    sessionId: text(session.id),
    current,
    label: list.find((row) => row.id === current)?.name || current || "Model",
    models: list,
    efforts: strings(capabilities.effort),
    ...(text(session.effort) ? { effort: text(session.effort) } : {}),
    started: turns.length > 0,
    running: turns.some((turn) => turn.status === "running"),
  };
}
/** "xhigh" as "Extra high"; other levels capitalized. */
export function effortLabel(effort: string) {
  if (effort === "xhigh") return "Extra high";
  return effort ? effort[0]?.toUpperCase() + effort.slice(1) : "Default";
}

export interface BackgroundTask {
  id: string;
  description: string;
  state: string;
  summary: string;
}
export function backgroundTasks(session: Row | undefined): BackgroundTask[] {
  const list = Array.isArray(session?.background) ? (session.background as Row[]) : [];
  return list.map((task) => ({
    id: text(task.id),
    description: text(task.description) || "Background task",
    state: text(task.state),
    summary: text(task.summary),
  }));
}
export const runningBackground = (session: Row | undefined) =>
  backgroundTasks(session).filter((task) => task.state === "running");

export interface PlanEntry {
  step: string;
  status: "pending" | "in_progress" | "completed";
}
/** The newest plan (to-do list) item of a thread, with progress. */
export function latestPlan(snapshot: Snapshot, threadId: string) {
  const item = (snapshot.entities.item ?? [])
    .filter((row) => row.threadId === threadId && row.kind === "plan")
    .sort((a, b) => Number(b.seq) - Number(a.seq))[0];
  const body = (item?.body ?? {}) as Row;
  const entries: PlanEntry[] = (Array.isArray(body.entries) ? (body.entries as Row[]) : [])
    .filter((entry) => text(entry.step))
    .map((entry) => ({
      step: text(entry.step),
      status:
        entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending",
    }));
  if (!entries.length) return undefined;
  const done = entries.filter((entry) => entry.status === "completed").length;
  const current = entries.find((entry) => entry.status === "in_progress");
  return { entries, done, total: entries.length, current: current?.step ?? "" };
}
