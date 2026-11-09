import { type Mailbox, mailboxes } from "@zoltbot/protocol";
import { inboxFromSnapshot, mailboxHints, mailboxLabels } from "@zoltbot/ui/inbox/data";
import type { Snapshot } from "./transport.js";

export { mailboxes, mailboxHints, mailboxLabels };
export type { Mailbox };
export {
  buildReply,
  type Draft,
  emptyDraft,
  itemText,
  type Letter,
  lettersFrom,
  type QuestionRef,
  replyQuestions,
} from "@zoltbot/ui/inbox/letters";

/** The Inbox from the phone's snapshot: the same mailboxes and order as the Mac's. */
export function inbox(snapshot: Snapshot, now = new Date()) {
  return inboxFromSnapshot(snapshot.entities, now);
}

/** The thread's row, wherever it is filed. */
export function inboxRow(snapshot: Snapshot, threadId: string, now = new Date()) {
  return inbox(snapshot, now).items.find((row) => row.thread.id === threadId);
}

/** "Later today", "Tomorrow morning", "Next week": the times a phone snooze offers. */
export function snoozeTimes(now = new Date()) {
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { label: "In 3 hours", at: new Date(now.getTime() + 3 * 3_600_000) },
    { label: "Tomorrow, 9:00", at: tomorrow },
    { label: "Monday, 9:00", at: monday },
  ];
}

/** "1 question · 1 approval" under a row. */
export function pendingLine(pending: Record<string, number>) {
  return Object.entries(pending)
    .map(([type, count]) => `${count} ${type}${count === 1 ? "" : "s"}`)
    .join(" · ");
}
