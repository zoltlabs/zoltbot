import { describe, expect, it } from "vitest";
import { enterAction } from "./send-key";

const key = (over: Partial<KeyboardEvent> = {}) => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...over,
});

describe("send key", () => {
  it("sends on Enter by default and adds a line with Shift", () => {
    expect(enterAction(key(), "enter")).toBe("send");
    expect(enterAction(key({ metaKey: true }), "enter")).toBe("send");
    expect(enterAction(key({ shiftKey: true }), "enter")).toBe("newline");
  });

  it("with ⌘ Enter chosen, Enter adds a line and ⌘ or Ctrl Enter sends", () => {
    expect(enterAction(key(), "mod-enter")).toBe("newline");
    expect(enterAction(key({ metaKey: true }), "mod-enter")).toBe("send");
    expect(enterAction(key({ ctrlKey: true }), "mod-enter")).toBe("send");
    expect(enterAction(key({ shiftKey: true }), "mod-enter")).toBe("newline");
  });

  it("keeps ⌥ Enter for side questions and ignores other keys", () => {
    expect(enterAction(key({ altKey: true }), "mod-enter")).toBe("send");
    expect(enterAction(key({ key: "a" }), "enter")).toBeUndefined();
  });
});
