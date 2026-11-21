import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../../shared/ipc";
import { DEFAULT_PREFERENCES } from "../../../shared/preferences";
import { soundFor, soundOn, TONES } from "./sounds";

const finished = {
  type: "turn-completed",
  botId: "a",
  threadId: "t",
  turnId: "u",
  status: "completed",
} as const;
const asked: AgentEvent = {
  type: "prompt",
  requestId: 1,
  botId: "a",
  threadId: "t",
  turnId: "u",
  questions: [],
};
const context = { focused: false, openBotId: "b", muted: () => false };

describe("soundFor", () => {
  it("plays for a finished task and a question", () => {
    expect(soundFor(finished, context)).toBe("taskFinished");
    expect(soundFor(asked, context)).toBe("needsYou");
  });

  it("stays quiet for the chat on screen while the window has focus", () => {
    expect(soundFor(finished, { ...context, focused: true, openBotId: "a" })).toBeUndefined();
    // Another chat, or the window in the background: the owner can't see it.
    expect(soundFor(finished, { ...context, focused: true })).toBe("taskFinished");
    expect(soundFor(asked, { ...context, openBotId: "a" })).toBe("needsYou");
  });

  it("stays quiet for a muted chat", () => {
    expect(soundFor(finished, { ...context, muted: (id) => id === "a" })).toBeUndefined();
    expect(soundFor(asked, { ...context, muted: (id) => id === "a" })).toBeUndefined();
  });

  it("stays quiet for a stopped or failed turn and other events", () => {
    expect(soundFor({ ...finished, status: "cancelled" }, context)).toBeUndefined();
    expect(soundFor({ type: "memory-changed" }, context)).toBeUndefined();
  });
});

describe("soundOn", () => {
  it("needs the main switch, the sound's own switch and some volume", () => {
    const prefs = { ...DEFAULT_PREFERENCES };
    expect(soundOn("taskFinished", prefs)).toBe(true);
    expect(soundOn("taskFinished", { ...prefs, sounds: false })).toBe(false);
    expect(soundOn("taskFinished", { ...prefs, soundTaskFinished: false })).toBe(false);
    expect(soundOn("needsYou", { ...prefs, soundTaskFinished: false })).toBe(true);
    expect(soundOn("messageSent", { ...prefs, soundVolume: 0 })).toBe(false);
  });
});

describe("TONES", () => {
  it("keeps every sound under 300 ms", () => {
    for (const tone of Object.values(TONES))
      for (const [, at, length] of tone.notes) expect(at + length).toBeLessThan(0.3);
  });
});
