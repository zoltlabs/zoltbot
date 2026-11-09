import { expect, it } from "vitest";
import { skillVersionDiff } from "./diff.js";

it("labels removals and additions for a screen reader without losing either side", () => {
  expect(skillVersionDiff("first\nmine\nlast", "first\nsource\nlast")).toBe(
    "unchanged: first\nremoved: mine\nadded: source\nunchanged: last",
  );
  expect(skillVersionDiff("same", "same")).toBe("No instruction changes.");
});
