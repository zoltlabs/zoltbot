import { describe, expect, it } from "vitest";
import { chiefClearTarget, followChiefClear } from "./chief-clear";

describe("following Zolt after Clear", () => {
  it("opens Zolt's new chat once, only from the chat being cleared", () => {
    followChiefClear("old");
    expect(chiefClearTarget("old", "old")).toBeUndefined();
    expect(chiefClearTarget("other", "new")).toBeUndefined();
    expect(chiefClearTarget("old", "new")).toBe("new");
    expect(chiefClearTarget("old", "new")).toBeUndefined();
  });
});
