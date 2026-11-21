// O1: turns an agent's Markdown reply into words a voice can read. Code is skipped, links read as
// their text and long numbers get the reader's own digit grouping. Shared by the Mac and phone.

/** Said in place of each code block. */
export const CODE_OMITTED = "Code omitted.";
/** The longest text one ElevenLabs request takes, so its audio fits one relay frame. */
export const SPEECH_REQUEST_CHARS = 400;
/** Settings row: `{ reference }` for the owner's ElevenLabs key in the keychain; `{}` when none. */
export const VOICE_ELEVENLABS_SETTING = "voice.elevenlabs";
/** Reading speeds offered on both devices. */
export const SPEECH_RATES = [0.75, 1, 1.25, 1.5, 2] as const;
/** System voices cut off long utterances, so text is spoken in pieces about this long. */
const PIECE_CHARS = 240;
/** Longer replies are cut, so preparing one never stalls the window. */
const MAX_CHARS = 20_000;

/** Replaces each fenced block with Code omitted, line by line. An unclosed fence runs to the end. */
function withoutFences(text: string): string {
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      out.push("", CODE_OMITTED, "");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Readable text for a Markdown message, in the reader's locale. */
export function speechText(markdown: string, locale?: string): string {
  const numbers = new Intl.NumberFormat(locale);
  let text = withoutFences(markdown.slice(0, MAX_CHARS).replace(/\r\n?/g, "\n"));
  // Indented code after a blank line.
  text = text.replace(/(^|\n\n)((?: {4}|\t)[^\n]*(?:\n(?: {4}|\t)[^\n]*)*)/g, `$1${CODE_OMITTED}`);
  text = text
    .replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>\n]*)?\/?>/g, " ")
    // Pictures by their description, links by their text.
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, "$1")
    .replace(/^[ \t]*\[[^\]\n]+\]:[ \t]+\S+.*$/gm, "")
    // A bare address is read as its site's name.
    .replace(/\bhttps?:\/\/(?:www\.)?([^/\s)]+)[^\s)]*/gi, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^ {0,3}#{1,6}\s+/gm, "")
    .replace(/^ {0,3}>\s?/gm, "")
    .replace(/^ {0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/^ {0,3}(?:[-*_]\s*){3,}$/gm, "")
    // Table rows: cells become a list; the divider row goes.
    .replace(/^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*$/gm, "")
    .replace(
      /^[ \t]*\|(.*)\|[ \t]*$/gm,
      (_, cells: string) =>
        `${cells
          .split("|")
          .map((cell) => cell.trim())
          .join(", ")}.`,
    )
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, "$1$2")
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");
  // Grouped digits, so 1234567 is read as one number. Versions, times and ids keep their form.
  text = text.replace(
    /(^|[^\w.:/-])(\d{5,})(?![\w.:/-]*\w)/g,
    (_, before: string, digits: string) =>
      digits.length > 15 ? `${before}${digits}` : `${before}${numbers.format(Number(digits))}`,
  );
  return text
    .split(/\n{2,}/)
    .map((block) =>
      block
        .replace(/\s*\n\s*/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .filter(
      (block, index, blocks) => !(block === CODE_OMITTED && blocks[index - 1] === CODE_OMITTED),
    )
    .join("\n\n");
}

/** Splits text into pieces at sentence ends, each no longer than `max` characters. */
export function speechPieces(text: string, max = PIECE_CHARS): string[] {
  const pieces: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const sentences = block.match(/[^.!?…。！？]+(?:[.!?…。！？]+["')\]」』]*\s*|$)/g) ?? [block];
    let current = "";
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      if (current && current.length + sentence.length + 1 > max) {
        pieces.push(current);
        current = "";
      }
      if (sentence.length <= max) {
        current = current ? `${current} ${sentence}` : sentence;
        continue;
      }
      // One very long sentence: break at commas, then at spaces.
      let rest = sentence;
      while (rest.length > max) {
        const window = rest.slice(0, max);
        const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" "));
        const at = cut > max / 3 ? cut + 1 : max;
        pieces.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      current = rest;
    }
    if (current) pieces.push(current);
  }
  return pieces;
}
