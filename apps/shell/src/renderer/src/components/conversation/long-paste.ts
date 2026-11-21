import { createSignal } from "solid-js";

// C13: a paste longer than 2,000 characters goes in as a pasted.txt attachment instead of filling
// the composer. The attachment card can put the words back inline.

export const LONG_PASTE_CHARS = 2000;
export const PASTED_NAME = "pasted.txt";

/** Saved drafts get a unique prefix ("<id>-pasted.txt"), so match the end of the name. */
export const isPastedName = (name: string) =>
  name === PASTED_NAME || name.endsWith(`-${PASTED_NAME}`);

export const isLongPaste = (text: string) => text.length > LONG_PASTE_CHARS;

export const lineCount = (text: string) => text.replace(/\n+$/, "").split("\n").length;

/** Pasted words kept until their attachment arrives, then by attachment id. */
const waiting: { text: string; bytes: number; at: number }[] = [];
const WAIT_MS = 120_000;
const KEEP = 50;
const byAttachment = new Map<string, string>();
const [version, setVersion] = createSignal(0);

/** Holds pasted words until the attachment made from them arrives. */
export function rememberPaste(text: string): void {
  waiting.push({ text, bytes: new TextEncoder().encode(text).length, at: Date.now() });
}

/** Sends the words to the app's attachment import as a pasted.txt file. */
export function attachPastedText(text: string, target: EventTarget = window): void {
  const transfer = new DataTransfer();
  transfer.items.add(new File([text], PASTED_NAME, { type: "text/plain" }));
  rememberPaste(text);
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }));
}

/**
 * Matches new pasted.txt attachments to the words that made them by size, so an import that
 * failed or finished out of order never lends its words to another file.
 */
export function notePastedAttachments(
  attachments: readonly { id: string; name: string; size: number }[],
): void {
  const now = Date.now();
  for (let i = waiting.length - 1; i >= 0; i--)
    if (now - (waiting[i]?.at ?? 0) > WAIT_MS) waiting.splice(i, 1);
  for (const attachment of attachments) {
    if (!isPastedName(attachment.name)) continue;
    const index = waiting.findIndex((entry) => entry.bytes === attachment.size);
    if (index < 0) continue;
    const [entry] = waiting.splice(index, 1);
    if (entry) byAttachment.set(attachment.id, entry.text);
    while (byAttachment.size > KEEP)
      byAttachment.delete(byAttachment.keys().next().value as string);
  }
  setVersion((n) => n + 1);
}

/** The words of a pasted.txt attachment made in this window, if any. */
export const pastedText = (attachmentId: string) => {
  version();
  return byAttachment.get(attachmentId);
};

export function forgetPasted(attachmentId: string): void {
  byAttachment.delete(attachmentId);
  setVersion((n) => n + 1);
}
