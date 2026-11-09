import { describe, expect, it } from "vitest";
import { type MailboxInput, threadMailbox } from "./inbox.js";

const now = new Date("2026-11-08T12:00:00Z");
const base = (thread: Partial<MailboxInput["thread"]> = {}, rest: Partial<MailboxInput> = {}) => ({
  thread: { archived: false, ...thread },
  pending: false,
  working: false,
  ...rest,
});

describe("threadMailbox", () => {
  it.each([
    [
      "a pending request wins over everything",
      base({ archived: true }, { pending: true, working: true }),
      "needs_you",
    ],
    [
      "a running turn shows as working, even once settled",
      base({ archived: true }, { working: true }),
      "working",
    ],
    [
      "an archived thread is settled",
      base({ archived: true }, { lastTurnEndedAt: "2026-11-08T11:00:00Z" }),
      "settled",
    ],
    [
      "a snoozed thread waits in Later",
      base({ snoozedUntil: "2026-11-09T09:00:00Z" }, { lastTurnEndedAt: "2026-11-08T11:00:00Z" }),
      "later",
    ],
    [
      "a past snooze no longer holds it",
      base({ snoozedUntil: "2026-11-08T09:00:00Z" }, { lastTurnEndedAt: "2026-11-08T11:00:00Z" }),
      "review",
    ],
    [
      "work that ended after the last read is ready to review",
      base({ lastReadAt: "2026-11-08T10:00:00Z" }, { lastTurnEndedAt: "2026-11-08T11:00:00Z" }),
      "review",
    ],
    [
      "a never-read thread with finished work is ready to review",
      base({}, { lastTurnEndedAt: "2026-11-08T11:00:00Z" }),
      "review",
    ],
    [
      "a read, idle thread is in no mailbox",
      base({ lastReadAt: "2026-11-08T11:30:00Z" }, { lastTurnEndedAt: "2026-11-08T11:00:00Z" }),
      undefined,
    ],
    ["a thread that never ran a turn is in no mailbox", base(), undefined],
  ])("%s", (_name, input, expected) => {
    expect(threadMailbox(input, now)).toBe(expected);
  });
});
