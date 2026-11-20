import { describe, expect, it } from "vitest";
import { stopsTurn } from "./stop-phrase";

describe("stopsTurn", () => {
  it("stops a working turn on a bare stop phrase", () => {
    expect(stopsTurn("Stop", 0, true)).toBe(true);
    expect(stopsTurn("  please stop!  ", 0, true)).toBe(true);
  });

  it("sends the message when nothing is running", () => {
    expect(stopsTurn("stop", 0, false)).toBe(false);
  });

  it("sends the message when it has attachments or more words", () => {
    expect(stopsTurn("stop", 1, true)).toBe(false);
    expect(stopsTurn("stop using tabs", 0, true)).toBe(false);
  });
});
