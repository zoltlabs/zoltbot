import { type Static, Type } from "@sinclair/typebox";
import { At, Id, OptionalText, object, Text, UserInputSchema, values } from "./common.js";
import { ThreadSchema } from "./entities.js";

// The Inbox shows threads the way a mail client shows conversations: one mailbox per state.
export const mailboxes = ["needs_you", "review", "working", "later", "settled"] as const;
export const MailboxSchema = values(mailboxes);
export type Mailbox = Static<typeof MailboxSchema>;

export interface MailboxInput {
  thread: { archived: boolean; lastReadAt?: string; snoozedUntil?: string };
  /** A request is waiting on the owner. */
  pending: boolean;
  /** A turn is running or input is queued. */
  working: boolean;
  /** When the newest turn ended, if it has. */
  lastTurnEndedAt?: string;
}

/**
 * Where a thread sits in the Inbox, or undefined when it is read and idle.
 * The first rule that matches wins, so a request on a snoozed or settled thread still reaches you.
 */
export function threadMailbox(input: MailboxInput, now = new Date()): Mailbox | undefined {
  const { thread } = input;
  if (input.pending) return "needs_you";
  if (input.working) return "working";
  if (thread.archived) return "settled";
  if (thread.snoozedUntil && Date.parse(thread.snoozedUntil) > now.getTime()) return "later";
  if (input.lastTurnEndedAt && input.lastTurnEndedAt > (thread.lastReadAt ?? "")) return "review";
  return undefined;
}

export const InboxRowSchema = object({
  thread: ThreadSchema,
  /** Absent when the thread is read and idle. */
  mailbox: Type.Optional(MailboxSchema),
  unread: Type.Boolean(),
  /** The start of the newest agent message, as plain text. */
  preview: Text,
  /** Pending requests by type, for the row's chips. */
  pending: Type.Record(Text, Type.Integer({ minimum: 1 })),
  lastTurnEndedAt: Type.Optional(At),
});
export type InboxRow = Static<typeof InboxRowSchema>;

export const ReplyAnswerSchema = object({
  interactionId: Id,
  version: Type.Integer({ minimum: 1 }),
  /** Per question item, as `interaction.answer` takes them. Absent when the owner skipped it. */
  answers: Type.Optional(
    Type.Record(Id, object({ options: Type.Optional(Type.Array(Id)), other: OptionalText })),
  ),
});
export type ReplyAnswer = Static<typeof ReplyAnswerSchema>;

export const inboxMethods = {
  "thread.markRead": {
    params: object({ id: Id, at: Type.Optional(At) }),
    result: ThreadSchema,
  },
  "thread.markUnread": { params: object({ id: Id }), result: ThreadSchema },
  "thread.snooze": {
    params: object({ id: Id, until: Type.Union([At, Type.Null()]) }),
    result: ThreadSchema,
  },
  "thread.settle": {
    params: object({ id: Id }),
    result: object({ thread: ThreadSchema, archived: Type.Boolean() }),
  },
  "thread.unarchive": { params: object({ id: Id }), result: ThreadSchema },
  "thread.inbox": {
    params: object({
      mailbox: Type.Optional(MailboxSchema),
      projectId: Type.Optional(Id),
      cursor: OptionalText,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    result: object({
      items: Type.Array(InboxRowSchema),
      counts: Type.Record(Text, Type.Integer({ minimum: 0 })),
      cursor: OptionalText,
    }),
  },
  "thread.reply": {
    params: object({
      threadId: Id,
      /** The whole letter as Markdown: quotes, answers, then anything else. */
      body: Text,
      answers: Type.Array(ReplyAnswerSchema, { maxItems: 20 }),
      attachments: Type.Optional(UserInputSchema),
      mode: Type.Optional(values(["queue", "steer"])),
      settle: Type.Optional(Type.Boolean()),
    }),
    result: object({
      id: Id,
      disposition: values(["started", "queued", "handled"]),
      resolved: Type.Array(Id),
    }),
  },
};

/** What a skipped question's tool call returns, so the agent reads on into the reply. */
export const skippedPointer =
  "The user skipped this question for now. Their next message may say more.";

type Row = Record<string, unknown>;
type State = { thread?: Row[]; turn?: Row[]; interaction?: Row[] };

/** Per-thread facts the mailbox rules need, read once from a snapshot. */
export function threadFacts(state: State) {
  const pending = new Map<string, Record<string, number>>(),
    running = new Set<string>(),
    ended = new Map<string, string>();
  for (const row of state.interaction ?? []) {
    if (row.state !== "pending") continue;
    const id = String(row.threadId),
      counts = pending.get(id) ?? {};
    counts[String(row.type)] = (counts[String(row.type)] ?? 0) + 1;
    pending.set(id, counts);
  }
  for (const row of state.turn ?? []) {
    const id = String(row.threadId);
    if (row.status === "running") running.add(id);
    else if (typeof row.endedAt === "string" && row.endedAt > (ended.get(id) ?? ""))
      ended.set(id, row.endedAt);
  }
  return {
    pending: (id: string) => pending.get(id),
    working: (id: string) => running.has(id),
    endedAt: (id: string) => ended.get(id),
    mailbox(thread: Row, now = new Date()): Mailbox | undefined {
      const id = String(thread.id),
        lastTurnEndedAt = ended.get(id);
      return threadMailbox(
        {
          thread: thread as MailboxInput["thread"],
          pending: pending.has(id),
          working: running.has(id),
          ...(lastTurnEndedAt ? { lastTurnEndedAt } : {}),
        },
        now,
      );
    },
  };
}

const previewLength = 200;
/** A message's first ~200 characters as plain text, for a list row. */
export function previewText(markdown: string) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > previewLength ? `${text.slice(0, previewLength - 1).trimEnd()}…` : text;
}

/**
 * Inbox rows in mailbox order, newest activity first, plus a count per mailbox.
 * `preview` returns a thread's newest agent message text; the daemon and clients read it differently.
 */
export function inboxRows(
  state: State,
  options: {
    preview: (threadIds: string[]) => Map<string, string>;
    mailbox?: Mailbox;
    projectId?: string;
    start?: number;
    limit?: number;
    now?: Date;
  },
) {
  const facts = threadFacts(state);
  const now = options.now ?? new Date();
  const counts = Object.fromEntries(mailboxes.map((box) => [box, 0])) as Record<Mailbox, number>;
  const rows: { thread: Row; mailbox: Mailbox }[] = [];
  for (const thread of state.thread ?? []) {
    if (options.projectId && thread.projectId !== options.projectId) continue;
    const mailbox = facts.mailbox(thread, now);
    if (!mailbox) continue;
    counts[mailbox] += 1;
    if (!options.mailbox || options.mailbox === mailbox) rows.push({ thread, mailbox });
  }
  rows.sort(
    (a, b) =>
      mailboxes.indexOf(a.mailbox) - mailboxes.indexOf(b.mailbox) ||
      String(b.thread.lastActivityAt).localeCompare(String(a.thread.lastActivityAt)),
  );
  const start = options.start ?? 0,
    limit = options.limit ?? rows.length,
    page = rows.slice(start, start + limit);
  const previews = options.preview(page.map((row) => String(row.thread.id)));
  const items: InboxRow[] = page.map(({ thread, mailbox }) => {
    const id = String(thread.id),
      endedAt = facts.endedAt(id);
    return {
      thread: thread as InboxRow["thread"],
      mailbox,
      unread: !!endedAt && endedAt > String(thread.lastReadAt ?? ""),
      preview: previewText(previews.get(id) ?? ""),
      pending: facts.pending(id) ?? {},
      ...(endedAt ? { lastTurnEndedAt: endedAt } : {}),
    };
  });
  return { items, counts, more: start + limit < rows.length };
}
