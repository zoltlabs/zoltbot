import { describe, expect, it } from "vitest";
import { isStopPhrase } from "./stop-phrase.js";

describe("stop phrases", () => {
  it.each([
    "stop",
    " Stop ",
    "STOP!",
    "ok stop",
    "okay  stop.",
    "stop please!!",
    "Please stop",
    "stop it",
    "stop now…",
  ])("stops on %j", (text) => expect(isStopPhrase(text)).toBe(true));

  it.each([
    "stop the server",
    "don't stop",
    "stops",
    "",
    "   ",
    "stop, then build",
    "nonstop",
  ])("sends %j as a message", (text) => expect(isStopPhrase(text)).toBe(false));

  it("uses another language's list when given one", () => {
    expect(isStopPhrase("Arrête", ["arrête"])).toBe(true);
    expect(isStopPhrase("stop", ["arrête"])).toBe(false);
  });
});
