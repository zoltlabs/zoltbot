// C10: short progress notes an agent posts during a long task. They are Zoltbot's own notes
// about a chat (I2), kept in one settings row per chat; they never become provider messages.

/** Longest note an agent may post. */
export const MAX_PROGRESS_LENGTH = 200;
/** An agent may post at most one note this often in a turn. */
export const PROGRESS_MIN_INTERVAL_MS = 30_000;
/** Notes kept per chat; the oldest go first. */
export const MAX_PROGRESS_NOTES = 50;

export const chatProgressKey = (threadId: string) => `chat.progress.${threadId}`;

export function chatProgressThread(key: unknown): string | undefined {
  return typeof key === "string" && key.startsWith("chat.progress.")
    ? key.slice("chat.progress.".length) || undefined
    : undefined;
}

export interface ProgressNote {
  id: string;
  turnId: string;
  text: string;
  at: string;
}

/** The stored notes, oldest first, skipping anything malformed. */
export function readProgressNotes(value: unknown): ProgressNote[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (note): note is ProgressNote =>
      !!note &&
      typeof note === "object" &&
      typeof (note as ProgressNote).id === "string" &&
      typeof (note as ProgressNote).turnId === "string" &&
      typeof (note as ProgressNote).text === "string" &&
      typeof (note as ProgressNote).at === "string",
  );
}

/** One paragraph, no longer than the limit. */
export function cleanProgress(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_PROGRESS_LENGTH ? `${line.slice(0, MAX_PROGRESS_LENGTH - 1)}…` : line;
}

/** Milliseconds until the turn may post another note, or 0. */
export function progressWait(value: unknown, turnId: string, now: number): number {
  const last = readProgressNotes(value)
    .filter((note) => note.turnId === turnId)
    .at(-1);
  const since = last ? now - Date.parse(last.at) : Number.NaN;
  // A clock that moved back reads as a long gap, so it never blocks notes for that long.
  if (!Number.isFinite(since) || since < 0) return 0;
  return since < PROGRESS_MIN_INTERVAL_MS ? PROGRESS_MIN_INTERVAL_MS - since : 0;
}

/** The notes with one more at the end, keeping the newest. */
export function withProgressNote(value: unknown, note: ProgressNote): ProgressNote[] {
  return [...readProgressNotes(value), note].slice(-MAX_PROGRESS_NOTES);
}
