// C6: a reply carries its quote to the agent. The quoted words go first as a Markdown quote, cut
// to 300 characters, and the quoted message's pictures go with it.

type Row = Record<string, unknown>;

const LIMIT = 300;
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function quoteText(words: string): string {
  // Quoting a reply quotes only what was written under its own quote.
  const inner = splitQuote(words.trim());
  const trimmed = (inner ? inner.rest || inner.quote : words).trim();
  const cut = trimmed.length > LIMIT ? `${trimmed.slice(0, LIMIT - 1).trimEnd()}…` : trimmed;
  return cut
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** The quote and pictures to send ahead of a reply, or undefined if the message is gone. */
export function replyQuote(
  items: readonly Row[],
  messageId: string,
): { text: string; images: Row[] } | undefined {
  const item = items.find((row) => row.id === messageId);
  if (!item) return undefined;
  const value = (item.body ?? {}) as Row;
  const input = item.kind === "user" && Array.isArray(value.input) ? (value.input as Row[]) : [];
  const words =
    item.kind === "user"
      ? input
          .filter((part) => part.type === "text")
          .map((part) => text(part.text))
          .join("\n")
      : text(value.text);
  const images = input
    .filter((part) => part.type === "image" && text(part.path))
    .map((part) => ({ type: "image", path: part.path, mimeType: part.mimeType }));
  if (!words.trim() && !images.length) return undefined;
  return { text: words.trim() ? quoteText(words) : "", images };
}

/** The text to send: the quote, a blank line, then the reply. */
export function withQuote(quote: string, reply: string): string {
  if (!quote) return reply;
  return reply.trim() ? `${quote}\n\n${reply}` : quote;
}

/** Splits a sent reply's leading quote from the words written under it. */
export function splitQuote(body: string): { quote: string; rest: string } | undefined {
  const lines = body.split("\n");
  let end = 0;
  while (end < lines.length && /^>( |$)/.test(lines[end] ?? "")) end += 1;
  if (!end) return undefined;
  const after = lines.slice(end);
  if (after.length && after[0] !== "") return undefined;
  const quote = lines
    .slice(0, end)
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  if (!quote) return undefined;
  return { quote, rest: after.slice(1).join("\n") };
}
