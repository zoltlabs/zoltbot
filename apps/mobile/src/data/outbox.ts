// C12: text messages written while the Mac is unreachable wait on the phone, survive a restart
// and send once the link is back. Each keeps the commandId of its first try, so the Mac applies
// it once even if an earlier try reached it before the link dropped.
import { offlineReason } from "./client.js";
import { OutcomeUnknownError } from "./transport.js";

export interface WaitingMessage {
  /** The commandId of every try, and the message's id on screen. */
  id: string;
  threadId: string;
  input: unknown[];
  text: string;
  createdAt: string;
  /** The Mac it is for, when the phone is paired with several. Older entries have none. */
  macId?: string;
}

/** A message with no Mac predates several Macs and belongs to whichever Mac is shown. */
const forMac = (entry: WaitingMessage, macId?: string) =>
  entry.macId === undefined || macId === undefined || entry.macId === macId;

export interface OutboxStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

const KEY = "zoltbot.outbox.v1";
const MAX_WAITING = 50;
/** Keychain items should stay small, so only short text messages wait. */
export const MAX_WAITING_CHARS = 4000;

const UNREACHABLE = new Set<string>(
  (["offline", "mac_offline", "connecting"] as const).map(offlineReason),
);

/** The Mac never answered, so the message may or may not have arrived. */
export function unreachable(error: unknown): boolean {
  return (
    error instanceof OutcomeUnknownError ||
    (error instanceof Error && UNREACHABLE.has(error.message))
  );
}

function valid(row: unknown): row is WaitingMessage {
  if (!row || typeof row !== "object") return false;
  const entry = row as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.threadId === "string" &&
    Array.isArray(entry.input) &&
    typeof entry.text === "string" &&
    typeof entry.createdAt === "string" &&
    (entry.macId === undefined || typeof entry.macId === "string")
  );
}

export function createOutbox(options: {
  storage: OutboxStorage;
  send(message: WaitingMessage): Promise<unknown>;
  changed(messages: readonly WaitingMessage[]): void;
}) {
  let entries: WaitingMessage[] = [];
  let writing: Promise<void> = Promise.resolve();
  let flushing: Promise<void> | undefined;
  // One send at a time, so the same commandId never goes out twice at once.
  let sending: Promise<unknown> = Promise.resolve();
  const save = async (next: WaitingMessage[]) => {
    const value = JSON.stringify(next);
    writing = writing.catch(() => undefined).then(() => options.storage.set(KEY, value));
    await writing;
    entries = next;
    options.changed(entries);
  };
  const remove = async (id: string) => {
    if (!entries.some((entry) => entry.id === id)) return;
    await save(entries.filter((entry) => entry.id !== id));
  };
  const sendOne = (entry: WaitingMessage) => {
    const run = sending.then(async () => {
      if (!entries.some((row) => row.id === entry.id)) return;
      await options.send(entry);
      await remove(entry.id);
    });
    sending = run.catch(() => undefined);
    return run;
  };
  const sendAll = async () => {
    const blocked = new Set<string>();
    const down = new Set<string>();
    const chat = (row: WaitingMessage) => `${row.macId ?? ""}\n${row.threadId}`;
    // Messages added while this runs are sent too.
    for (;;) {
      const entry = entries.find((row) => !blocked.has(chat(row)) && !down.has(row.macId ?? ""));
      if (!entry) return;
      try {
        await sendOne(entry);
      } catch (error) {
        // An unreachable Mac holds only its own messages; another Mac's still go.
        if (unreachable(error)) down.add(entry.macId ?? "");
        // Refused: it stays for the owner to see, and later ones in that chat keep their place.
        else blocked.add(chat(entry));
      }
    }
  };
  return {
    async load() {
      try {
        const raw = JSON.parse((await options.storage.get(KEY)) ?? "[]") as unknown;
        entries = Array.isArray(raw) ? raw.filter(valid).slice(0, MAX_WAITING) : [];
      } catch {
        entries = [];
      }
      options.changed(entries);
    },
    list: (threadId: string, macId?: string) =>
      entries.filter((entry) => entry.threadId === threadId && forMac(entry, macId)),
    has: (threadId: string, macId?: string) =>
      entries.some((entry) => entry.threadId === threadId && forMac(entry, macId)),
    /**
     * Ties messages saved before several Macs to `first`, the only Mac then, and drops any whose
     * Mac is no longer paired.
     */
    async settle(first: string, paired: readonly string[]) {
      const next = entries
        .map((entry) => (entry.macId === undefined ? { ...entry, macId: first } : entry))
        .filter((entry) => paired.includes(entry.macId as string));
      if (next.some((entry, index) => entry !== entries[index]) || next.length !== entries.length)
        await save(next);
    },
    /** A forgotten Mac's messages can never send. */
    async dropMac(macId: string) {
      if (entries.some((entry) => entry.macId === macId))
        await save(entries.filter((entry) => entry.macId !== macId));
    },
    async add(entry: WaitingMessage) {
      if (entries.length >= MAX_WAITING)
        throw new Error("50 messages are waiting to send. Delete some first.");
      if (entry.text.length > MAX_WAITING_CHARS)
        throw new Error("This message is too long to keep until your Mac is back.");
      // Saved first: a message that couldn't be kept isn't sent later.
      await save([...entries, entry]);
    },
    remove,
    flush() {
      flushing ??= sendAll().finally(() => {
        flushing = undefined;
      });
      return flushing;
    },
    async sendNow(id: string) {
      await flushing;
      const entry = entries.find((row) => row.id === id);
      if (entry) await sendOne(entry);
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;
