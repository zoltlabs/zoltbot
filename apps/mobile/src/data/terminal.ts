import { stripAnsi } from "@zoltbot/ui/chat/tools/tool-data";

// The phone shows terminals as plain text: it follows output, it does not emulate a screen.

/** Keeps about this much of the newest output, cut at a line break. */
const KEEP = 64 * 1024;

// Stray controls left after the escape sequences are removed (tab and line breaks stay).
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal output is made of control characters.
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Terminal output as readable text: escape codes removed, carriage-return redraws collapsed. */
export function plainOutput(data: string): string {
  return stripAnsi(data)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(control, "");
}

/** Appends new output and drops the oldest lines once the buffer is too long for a phone. */
export function appendOutput(shown: string, data: string): string {
  const next = shown + plainOutput(data);
  if (next.length <= KEEP) return next;
  const cut = next.indexOf("\n", next.length - KEEP);
  return next.slice(cut < 0 ? next.length - KEEP : cut + 1);
}

/** The interrupt key, sent as input to a terminal this device owns. */
export const interruptKey = "\u0003";
