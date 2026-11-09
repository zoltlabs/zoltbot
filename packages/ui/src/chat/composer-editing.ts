export type MarkdownFormat = "bold" | "italic" | "code" | "list" | "quote";

export function formatMarkdown(text: string, start: number, end: number, format: MarkdownFormat) {
  const selection = text.slice(start, end);
  const line = format === "list" || format === "quote";
  const from = line && start > 0 ? text.lastIndexOf("\n", start - 1) + 1 : line ? 0 : start;
  const selected = line ? text.slice(from, end) : selection;
  const marker = { bold: "**", italic: "*", code: "`", list: "- ", quote: "> " }[format];
  if (
    !line &&
    text.slice(start - marker.length, start) === marker &&
    text.slice(end, end + marker.length) === marker
  ) {
    return {
      text: text.slice(0, start - marker.length) + selection + text.slice(end + marker.length),
      start: start - marker.length,
      end: end - marker.length,
    };
  }
  const content = selected || (line ? "" : "text");
  const insertion = line
    ? content
        .split("\n")
        .map((line) => marker + line)
        .join("\n")
    : marker + content + marker;
  return {
    text: text.slice(0, from) + insertion + text.slice(end),
    start: from + marker.length,
    end: from + insertion.length - (line ? 0 : marker.length),
  };
}

/** Mirrors T3's composition / repeat guard; Safari also reports keyCode 229 during IME. */
export function composingKey(
  event: { isComposing?: boolean; keyCode?: number },
  composing: boolean,
) {
  return composing || event.isComposing === true || event.keyCode === 229;
}
// Bound expensive Markdown rendering without modifying or truncating the user's draft.
export const COMPOSER_PREVIEW_LIMIT = 32_768;
