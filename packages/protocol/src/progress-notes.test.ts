import { describe, expect, it } from "vitest";
import {
  chatProgressKey,
  chatProgressThread,
  cleanProgress,
  MAX_PROGRESS_LENGTH,
  MAX_PROGRESS_NOTES,
  progressWait,
  readProgressNotes,
  withProgressNote,
} from "./progress-notes.js";

const note = (id: string, at: string) => ({ id, turnId: "t", text: id, at });

describe("progress notes", () => {
  it("round-trips the chat key", () => {
    expect(chatProgressThread(chatProgressKey("c1"))).toBe("c1");
    expect(chatProgressThread("chat.status.c1")).toBeUndefined();
  });

  it("keeps notes in order, drops malformed rows and caps the count", () => {
    expect(readProgressNotes([note("a", "x"), { id: 1 }, null])).toEqual([note("a", "x")]);
    let value: unknown = [];
    for (let i = 0; i < MAX_PROGRESS_NOTES + 5; i++)
      value = withProgressNote(value, note(`${i}`, ""));
    const notes = readProgressNotes(value);
    expect(notes).toHaveLength(MAX_PROGRESS_NOTES);
    expect(notes[0]?.id).toBe("5");
  });

  it("cleans text to one paragraph within the limit", () => {
    expect(cleanProgress("  Tests\n\npass  ")).toBe("Tests pass");
    expect(cleanProgress("x".repeat(500))).toHaveLength(MAX_PROGRESS_LENGTH);
  });

  it("allows one note every 30 seconds in a turn", () => {
    const at = "2026-11-21T10:00:00.000Z";
    const t = Date.parse(at);
    expect(progressWait([], "t", t)).toBe(0);
    expect(progressWait([note("a", at)], "t", t + 10_000)).toBe(20_000);
    expect(progressWait([note("a", at)], "t", t + 30_000)).toBe(0);
    // A new turn starts with its plan, however recent the last turn's note.
    expect(progressWait([note("a", at)], "next", t + 1_000)).toBe(0);
    // A clock that moved back doesn't block notes.
    expect(progressWait([note("a", at)], "t", t - 3_600_000)).toBe(0);
  });
});
