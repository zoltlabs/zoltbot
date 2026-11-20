/** C3: phrases that stop a running turn when sent on their own. English is the default list. */
export const STOP_PHRASES = [
  "stop",
  "ok stop",
  "okay stop",
  "stop please",
  "please stop",
  "stop it",
  "stop now",
] as const;

/**
 * True when `text` is only a stop phrase: trimmed, case-insensitive, with any trailing
 * punctuation ignored. "stop the server" is a message, not a stop.
 */
export function isStopPhrase(text: string, phrases: readonly string[] = STOP_PHRASES): boolean {
  const said = text
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s.!?…,;:]+$/u, "")
    .replace(/\s+/g, " ");
  return said !== "" && phrases.some((phrase) => phrase.toLocaleLowerCase() === said);
}
