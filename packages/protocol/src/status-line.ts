// C9: the line under a chat while its agent works. The agent writes it with chat_signal; until
// it does, the line comes from the tool the agent is running.

/** Longest status an agent may set. */
export const MAX_STATUS_LENGTH = 60;
/** The line changes at most this often, so it reads calmly. */
export const STATUS_MIN_INTERVAL_MS = 3000;

export const chatStatusKey = (threadId: string) => `chat.status.${threadId}`;

export function chatStatusThread(key: unknown): string | undefined {
  return typeof key === "string" && key.startsWith("chat.status.")
    ? key.slice("chat.status.".length) || undefined
    : undefined;
}

export interface ChatStatus {
  turnId: string;
  text: string;
  at: string;
}

/** The status the agent set for this turn, or undefined. */
export function readChatStatus(value: unknown, turnId: string | undefined): string | undefined {
  const status = value as Partial<ChatStatus> | null | undefined;
  if (!turnId || status?.turnId !== turnId || typeof status.text !== "string") return undefined;
  return cleanStatus(status.text) || undefined;
}

/** One line, no longer than the limit. */
export function cleanStatus(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_STATUS_LENGTH ? `${line.slice(0, MAX_STATUS_LENGTH - 1)}…` : line;
}

type Row = Record<string, unknown>;

const fileName = (body: Row) => {
  const path = (Array.isArray(body.locations) ? (body.locations[0] as Row | undefined) : undefined)
    ?.path;
  return typeof path === "string" ? path.split(/[\\/]/).filter(Boolean).pop() : undefined;
};

/** A line from the tool the agent is running; "Working" when nothing better fits. */
export function toolStatus(body: Row | undefined): string {
  if (!body) return "Working";
  if (body.check === "tests") return "Running tests";
  const file = fileName(body);
  switch (body.kind) {
    case "edit":
      return file ? cleanStatus(`Editing ${file}`) : "Editing files";
    case "read":
      return file ? cleanStatus(`Reading ${file}`) : "Reading files";
    case "search":
      return "Searching";
    case "fetch":
      return "Reading a web page";
    case "execute":
      return "Running a command";
    default:
      return "Working";
  }
}

/**
 * The line to show for a running turn: the agent's own words, else its newest running tool's,
 * else "Working".
 */
export function statusLine(input: {
  stored: unknown;
  turnId: string | undefined;
  tools: readonly Row[];
}): string {
  const own = readChatStatus(input.stored, input.turnId);
  if (own) return own;
  const running = [...input.tools]
    .reverse()
    .find(
      (item) =>
        item.kind === "tool" &&
        item.turnId === input.turnId &&
        ((item.body ?? {}) as Row).status === "running",
    );
  return toolStatus(running?.body as Row | undefined);
}

/**
 * Holds each line for at least the interval. Returns the line to show now and, when a newer one
 * is waiting, how long until it may show.
 */
export function nextStatus(
  shown: { text: string; at: number } | undefined,
  wanted: string,
  now: number,
  interval = STATUS_MIN_INTERVAL_MS,
): { text: string; at: number; waitMs?: number } {
  if (!shown) return { text: wanted, at: now };
  if (shown.text === wanted) return shown;
  const elapsed = now - shown.at;
  if (elapsed >= interval) return { text: wanted, at: now };
  return { ...shown, waitMs: interval - elapsed };
}
