import { describe, expect, it } from "vitest";
import {
  isLongPaste,
  isPastedName,
  LONG_PASTE_CHARS,
  lineCount,
  notePastedAttachments,
  pastedText,
  rememberPaste,
} from "./long-paste";

describe("long paste", () => {
  it("turns only pastes longer than 2,000 characters into a file", () => {
    expect(isLongPaste("x".repeat(LONG_PASTE_CHARS))).toBe(false);
    expect(isLongPaste("x".repeat(LONG_PASTE_CHARS + 1))).toBe(true);
    expect(lineCount("a\nb\nc")).toBe(3);
    expect(lineCount("a\nb\n")).toBe(2);
  });

  it("remembers which attachment holds which pasted words", () => {
    const target = new EventTarget();
    target.addEventListener("paste", () => undefined);
    // jsdom has no DataTransfer or ClipboardEvent; the matching doesn't depend on them.
    notePastedAttachments([{ id: "other", name: "notes.txt", size: 3 }]);
    expect(pastedText("other")).toBeUndefined();
    expect(isPastedName("pasted.txt")).toBe(true);
    expect(isPastedName("0c1d-pasted.txt")).toBe(true);
    expect(isPastedName("unpasted.txt")).toBe(false);
  });

  it("matches words to attachments by size, whatever order the imports finish in", () => {
    rememberPaste("first, the longer paste");
    rememberPaste("second");
    notePastedAttachments([{ id: "b", name: "9f-pasted.txt", size: 6 }]);
    notePastedAttachments([{ id: "a", name: "3c-pasted.txt", size: 23 }]);
    expect(pastedText("a")).toBe("first, the longer paste");
    expect(pastedText("b")).toBe("second");
    // A pasted.txt from elsewhere borrows nothing.
    notePastedAttachments([{ id: "c", name: "pasted.txt", size: 6 }]);
    expect(pastedText("c")).toBeUndefined();
  });
});
