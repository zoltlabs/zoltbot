import { describe, expect, it } from "vitest";
import {
  applyDictationTranscript,
  captureDictationAnchor,
  collectContextualStrings,
  formatDictationElapsed,
  matchesDictationShortcut,
  rollbackDictationAnchor,
} from "./dictation-state.js";

describe("dictation-state", () => {
  it("inserts partial and final transcripts at the cursor without overwriting surrounding text", () => {
    const initial = "Check @Composer.tsx and run tests.";
    const cursor = "Check @Composer.tsx".length;
    const anchor = captureDictationAnchor(initial, cursor, cursor);

    const partial1 = applyDictationTranscript(anchor, "for accessibility");
    expect(partial1.draft).toBe("Check @Composer.tsx for accessibility and run tests.");
    expect(partial1.cursor).toBe("Check @Composer.tsx for accessibility".length);

    const partial2 = applyDictationTranscript(anchor, "for keyboard and focus states");
    expect(partial2.draft).toBe("Check @Composer.tsx for keyboard and focus states and run tests.");
    expect(partial2.cursor).toBe("Check @Composer.tsx for keyboard and focus states".length);

    const rolledBack = rollbackDictationAnchor(anchor);
    expect(rolledBack).toEqual({
      draft: initial,
      cursor,
    });
  });

  it("replaces only the selected range when a selection is active at dictation start", () => {
    const initial = "Update the old component now";
    const start = initial.indexOf("old component");
    const end = start + "old component".length;
    const anchor = captureDictationAnchor(initial, start, end);

    const updated = applyDictationTranscript(anchor, "Composer toolbar");
    expect(updated.draft).toBe("Update the Composer toolbar now");
    expect(updated.cursor).toBe("Update the Composer toolbar".length);
  });

  it("avoids duplicate spaces when inserting into an empty draft or before punctuation", () => {
    const emptyAnchor = captureDictationAnchor("", 0, 0);
    expect(applyDictationTranscript(emptyAnchor, "  Run the check suite  ")).toEqual({
      draft: "Run the check suite",
      cursor: "Run the check suite".length,
    });

    const punctuationAnchor = captureDictationAnchor("Hello!", 5, 5);
    expect(applyDictationTranscript(punctuationAnchor, "everyone")).toEqual({
      draft: "Hello everyone!",
      cursor: "Hello everyone".length,
    });
  });

  it("matches macOS Option+Space (including non-breaking space) and Cmd+Shift+D shortcuts", () => {
    expect(
      matchesDictationShortcut(
        { key: "\u00a0", code: "Space", altKey: true, metaKey: false, ctrlKey: false },
        "alt+space",
      ),
    ).toBe(true);
    expect(
      matchesDictationShortcut(
        { key: " ", code: "Space", altKey: false, metaKey: false },
        "alt+space",
      ),
    ).toBe(false);
    expect(
      matchesDictationShortcut(
        { key: "D", code: "KeyD", metaKey: true, shiftKey: true, altKey: false },
        "mod+shift+d",
      ),
    ).toBe(true);
    expect(matchesDictationShortcut({ key: " ", code: "Space", altKey: true }, "off")).toBe(false);
  });

  it("formats elapsed seconds and filters contextual vocabulary safely", () => {
    expect(formatDictationElapsed(0)).toBe("0:00");
    expect(formatDictationElapsed(4900)).toBe("0:04");
    expect(formatDictationElapsed(65_000)).toBe("1:05");

    expect(
      collectContextualStrings({
        projectName: "Zoltbot",
        profileName: "Builder",
        commands: [{ name: "compact" }, { name: "review" }],
        extra: ["sk-1234567890", "TOKEN=abc", "Composer.tsx"],
      }),
    ).toEqual(["Zoltbot", "Builder", "compact", "review", "Composer.tsx"]);
  });
});
