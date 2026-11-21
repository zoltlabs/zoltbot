// C13: a paste longer than 2,000 characters becomes its own attachment instead of filling the
// composer. The phone can't hand the Mac a new file, so it travels as a separate text part.
import { t } from "../i18n";
import type { Attachment } from "./attachments";

export const LONG_PASTE_CHARS = 2000;

/** The text one change inserted, found by trimming what stayed the same at both ends. */
export function insertedText(before: string, after: string): { start: number; text: string } {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return { start, text: after.slice(start, after.length - end) };
}

/**
 * Splits a composer change into the draft to keep and, for a long paste, the pasted words.
 * Typing and short pastes pass through untouched.
 */
export function takeLongPaste(before: string, after: string): { draft: string; pasted?: string } {
  // A paste can replace a selection, so look at what went in, not how much the draft grew.
  if (after.length <= LONG_PASTE_CHARS) return { draft: after };
  const { start, text } = insertedText(before, after);
  if (text.length <= LONG_PASTE_CHARS) return { draft: after };
  return { draft: after.slice(0, start) + after.slice(start + text.length), pasted: text };
}

export const lineCount = (text: string) => text.replace(/\n+$/, "").split("\n").length;

export function pastedAttachment(id: string, text: string): Attachment {
  return {
    id,
    label: t("composer.pastedText", { lines: lineCount(text) }),
    part: { type: "text", text },
    pasted: true,
  };
}
