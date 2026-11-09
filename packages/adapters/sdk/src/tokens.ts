import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/o200k_base";

let encoding: Tiktoken | undefined;
/** Offline reference measurement. Other provider vocabularies still need calibration. */
export function referenceTokenEstimate(text: string): number {
  encoding ??= new Tiktoken(ranks);
  let actual = 0;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 256, text.length);
    if (end < text.length) {
      const space = Math.max(text.lastIndexOf(" ", end - 1), text.lastIndexOf("\n", end - 1));
      if (space > start + 192) end = space;
      const last = text.charCodeAt(end - 1),
        next = text.charCodeAt(end);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    }
    actual += encoding.encode(text.slice(start, end), [], []).length;
    start = end;
  }
  return actual + Math.floor(actual * 0.05);
}
export const referenceTokenMetadata = {
  encoding: "o200k_base",
  safetyFactor: 1.05,
  providerVerified: false,
} as const;
