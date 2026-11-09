import { type InboxRow, inboxRows, type Mailbox } from "@zoltbot/protocol";
import { body, type Row, text } from "../chat/types.js";

type Entities = Record<string, Row[] | undefined>;

export const mailboxLabels: Record<Mailbox, string> = {
  needs_you: "Needs you",
  review: "Ready to review",
  working: "Working",
  later: "Later",
  settled: "Settled",
};
export const mailboxHints: Record<Mailbox, string> = {
  needs_you: "Questions and approvals, one row per conversation",
  review: "Finished work you have not opened",
  working: "Still running. Each one writes when it needs you or is done",
  later: "Snoozed until a time you picked, or until the agent asks for something",
  settled: "Done and put away",
};

/** Every thread's newest agent message, read from the snapshot the desktop already holds. */
function latestMessages(entities: Entities) {
  const latest = new Map<string, Row>();
  for (const item of entities.item ?? []) {
    if (item.kind !== "message") continue;
    const id = text(item.threadId),
      previous = latest.get(id);
    if (!previous || Number(item.seq) > Number(previous.seq)) latest.set(id, item);
  }
  return latest;
}

/** The Inbox from the local snapshot: the same rules and order as the daemon's `thread.inbox`. */
export function inboxFromSnapshot(entities: Entities, now = new Date()) {
  const latest = latestMessages(entities);
  // Task threads live on the Tasks page; their requests still reach Needs you through the thread.
  const threads = (entities.thread ?? []).filter(
    (thread) =>
      thread.kind !== "task" ||
      entities.interaction?.some((row) => row.threadId === thread.id && row.state === "pending"),
  );
  return inboxRows(
    { thread: threads, turn: entities.turn ?? [], interaction: entities.interaction ?? [] },
    {
      now,
      preview: (ids) =>
        new Map(
          ids.flatMap((id) => {
            const item = latest.get(id);
            return item ? [[id, text(body(item).text)] as const] : [];
          }),
        ),
    },
  );
}

/** Keep the letter being read open after its answer/read marker removes it from mailbox rows. */
export function openedInboxRow(
  items: InboxRow[],
  entities: Entities,
  selected?: string,
): InboxRow | undefined {
  if (!selected) return undefined;
  const listed = items.find((row) => row.thread.id === selected);
  if (listed) return listed;
  const thread = entities.thread?.find((row) => row.id === selected && !row.archived);
  if (!thread) return undefined;
  return {
    thread: thread as InboxRow["thread"],
    mailbox: "review",
    unread: false,
    preview: "",
    pending: {},
  };
}

export type { InboxRow };

/** "3 questions · 1 approval" for a row's chips. */
export function pendingChips(pending: Record<string, number>) {
  return Object.entries(pending).map(
    ([type, count]) => `${count} ${type}${count === 1 ? "" : "s"}`,
  );
}

/** "11:47", "Tue" or "3 Nov": how mail clients date a row. */
export function rowTime(at: string | undefined, now = new Date()) {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  if (date.toDateString() === now.toDateString())
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
