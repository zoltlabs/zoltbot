// A2: how an agent writes to the owner. It changes tone, not what the agent does. The line is
// added once to the instructions a session starts with (I3: never resent each turn), so a change
// applies to the agent's next chat.

export const TALKING_STYLES = ["neutral", "warm", "casual", "direct"] as const;
export type TalkingStyle = (typeof TALKING_STYLES)[number];

/** The settings key of the style new agents start with. */
export const DEFAULT_TALKING_STYLE_KEY = "agents.defaultStyle";

const lines: Record<TalkingStyle, string | undefined> = {
  neutral: undefined,
  warm: "When you write to the owner, be warm and friendly, and keep it clear.",
  casual: "When you write to the owner, be casual and relaxed, like a teammate. Keep it short.",
  direct:
    "When you write to the owner, be direct: lead with the answer and skip pleasantries and hedging.",
};

export function isTalkingStyle(value: unknown): value is TalkingStyle {
  return typeof value === "string" && (TALKING_STYLES as readonly string[]).includes(value);
}

/**
 * The style an agent uses: its own, else the owner's default from settings, else neutral.
 * Anything malformed reads as neutral.
 */
export function effectiveTalkingStyle(own: unknown, fallback: unknown): TalkingStyle {
  if (isTalkingStyle(own)) return own;
  return isTalkingStyle(fallback) ? fallback : "neutral";
}

/**
 * How every agent writes to the owner, whatever its style. Sessions start with it (I3), and it
 * counts against the fixed launch budget, so keep it short.
 */
export const writingRules =
  "Writing to the owner: lead with the result or decision. Say what changed for them, not what you ran: no hashes, IDs, paths or tool names unless asked. Put what matters most first and fold minor items into one line. Use short paragraphs; lists only for three or more parallel items, tables only to compare, no headings under 150 words. Status words: done (only after you checked), drafted, waiting on what, blocked because why. To ask, ask one question with why and your pick, after doing what doesn't depend on it. No closing recap, no 'let me know', no 'want me to…?' after finished work.";

/** The sentence a session's instructions end with, or undefined for neutral. */
export function talkingStyleLine(style: TalkingStyle): string | undefined {
  return lines[style];
}
