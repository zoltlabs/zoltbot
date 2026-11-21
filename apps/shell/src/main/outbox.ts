// C12: messages written while Zoltbot's daemon is unreachable wait here, survive a restart, and
// send once it is back. Each keeps the commandId of its first attempt, so the daemon applies a
// message once even when an earlier attempt reached it before the connection dropped.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AttachmentSummary,
  ConversationMessage,
  QueuedMessageReceipt,
  SendMessageInput,
} from "../shared/ipc";

export interface OutboxEntry {
  /** The commandId used for every attempt, and the waiting message's id. */
  id: string;
  botId: string;
  /** The turn.send input parts, as built when the owner pressed Send. */
  parts: unknown[];
  text: string;
  attachments: AttachmentSummary[];
  replyToMessageId?: string;
  createdAt: string;
}

/** Errors that mean the daemon never answered, so the message may or may not have arrived. */
export function unreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message === "Daemon unavailable" || message === "Connection closed";
}

const MAX_ENTRIES = 200;

function valid(row: unknown): row is OutboxEntry {
  if (!row || typeof row !== "object") return false;
  const entry = row as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.botId === "string" &&
    Array.isArray(entry.parts) &&
    typeof entry.text === "string" &&
    Array.isArray(entry.attachments) &&
    typeof entry.createdAt === "string"
  );
}

export interface OutboxOptions {
  path: string;
  /** Sends one message with its commandId. Rejects with the daemon's error. */
  send(entry: OutboxEntry): Promise<unknown>;
  /** Called after a chat's waiting messages change. */
  changed(botId: string): void;
}

export class Outbox {
  private entries: OutboxEntry[] = [];
  private writing: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | undefined;
  /** One send at a time, so the same commandId never goes out twice at once. */
  private sending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OutboxOptions) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch {
      this.entries = [];
      return;
    }
    try {
      const raw = JSON.parse(text) as unknown;
      this.entries = Array.isArray(raw) ? raw.filter(valid).slice(0, MAX_ENTRIES) : [];
    } catch {
      // Kept aside rather than overwritten, so the messages in it can still be recovered.
      await rename(this.options.path, `${this.options.path}.damaged`).catch(() => undefined);
      this.entries = [];
    }
  }

  /** Whether a chat has messages waiting, so a new one queues behind them. */
  has(botId: string): boolean {
    return this.entries.some((entry) => entry.botId === botId);
  }

  list(botId: string): OutboxEntry[] {
    return this.entries.filter((entry) => entry.botId === botId);
  }

  /** Keeps a message the daemon didn't receive, and answers the send like a queued one. */
  async keep(
    commandId: string,
    input: SendMessageInput,
    parts: unknown[],
    text: string,
    attachments: { summary: AttachmentSummary }[],
  ): Promise<QueuedMessageReceipt> {
    await this.add({
      id: commandId,
      botId: input.botId,
      parts,
      text,
      attachments: attachments.map((attachment) => attachment.summary),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      createdAt: new Date().toISOString(),
    });
    return {
      messageId: commandId,
      deliveries: [
        { id: commandId, recipientBotId: input.botId, status: "queued", position: null },
      ],
    };
  }

  /** Keeps a message that couldn't be sent. Throws when too many are already waiting. */
  async add(entry: OutboxEntry): Promise<void> {
    if (this.entries.some((row) => row.id === entry.id)) return;
    if (this.entries.length >= MAX_ENTRIES)
      throw new Error("200 messages are waiting to send. Delete some first.");
    // Saved first: a message that couldn't be written isn't kept, so a retry can't send it twice.
    const next = [...this.entries, entry];
    await this.save(next);
    this.entries = next;
    this.options.changed(entry.botId);
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.find((row) => row.id === id);
    if (!entry) return;
    this.entries = this.entries.filter((row) => row.id !== id);
    await this.save(this.entries);
    this.options.changed(entry.botId);
  }

  /**
   * Sends waiting messages in the order they were written, stopping while the daemon is
   * unreachable. A message the daemon refuses stays so the owner can see it and delete it.
   */
  flush(): Promise<void> {
    this.flushing ??= this.sendAll().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** Sends one waiting message now. Rejects with the reason it couldn't be sent. */
  async sendNow(id: string): Promise<void> {
    await this.flushing;
    const entry = this.entries.find((row) => row.id === id);
    if (!entry) return;
    await this.sendOne(entry);
  }

  private sendOne(entry: OutboxEntry): Promise<void> {
    const run = this.sending.then(async () => {
      if (!this.entries.includes(entry)) return;
      await this.options.send(entry);
      await this.remove(entry.id);
    });
    this.sending = run.catch(() => undefined);
    return run;
  }

  private async sendAll(): Promise<void> {
    const blocked = new Set<string>();
    // Messages in one chat keep their order: after one fails, the rest of that chat waits.
    // Messages added while this runs are sent too.
    for (;;) {
      const entry = this.entries.find((row) => !blocked.has(row.botId));
      if (!entry) return;
      try {
        await this.sendOne(entry);
      } catch (error) {
        if (unreachable(error)) return;
        blocked.add(entry.botId);
      }
    }
  }

  private save(entries: OutboxEntry[]): Promise<void> {
    const snapshot = JSON.stringify(entries);
    const path = this.options.path;
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, path);
      });
    return this.writing;
  }
}

/** How a waiting message shows in its chat. */
export function waitingMessage(entry: OutboxEntry): ConversationMessage {
  return {
    id: entry.id,
    author: "user",
    source: "user",
    text: entry.text,
    createdAt: entry.createdAt,
    status: "completed",
    attachments: entry.attachments,
    ...(entry.replyToMessageId ? { replyToMessageId: entry.replyToMessageId } : {}),
    waiting: true,
  };
}

/** The outbox for turn.send: each message resends with the commandId of its first attempt. */
export function turnOutbox(
  client: { call(method: string, params: unknown, commandId?: string): Promise<unknown> },
  path: string,
  changed: (botId: string) => void,
): Outbox {
  return new Outbox({
    path,
    changed,
    send: (entry) =>
      client.call(
        "turn.send",
        { threadId: entry.botId, input: entry.parts, mode: "queue", outputMode: "auto" },
        entry.id,
      ),
  });
}
