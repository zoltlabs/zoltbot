import { describe, expect, it } from "vitest";
import { type MenuCaps, messageMenu, messageTime } from "./message-menu";

const base: MenuCaps = {
  mine: false,
  hasText: true,
  markable: true,
  pinned: false,
  readable: true,
  reading: false,
  branch: true,
  forward: true,
};
const keys = (caps: Partial<MenuCaps>) => messageMenu({ ...base, ...caps }).map((item) => item.key);

describe("messageMenu", () => {
  it("puts the agent's message actions in the gesture order, then the rest", () => {
    expect(keys({})).toEqual([
      "reply",
      "copy",
      "pin",
      "read",
      "branch",
      "hide",
      "react",
      "forward",
      "share",
    ]);
  });

  it("offers your sent message an edit instead of a branch or read aloud", () => {
    expect(
      keys({ mine: true, readable: false, branch: false, forward: false, edit: "sent" }),
    ).toEqual(["reply", "copy", "pin", "hide", "react", "edit", "share"]);
    expect(messageMenu({ ...base, edit: "sent" }).find((i) => i.key === "edit")?.label).toBe(
      "Edit and send again",
    );
  });

  it("keeps a queued message to its queue actions, Copy and Share", () => {
    expect(keys({ mine: true, edit: "queued", queue: { moveUp: true, moveDown: false } })).toEqual([
      "sendNow",
      "edit",
      "moveUp",
      "copy",
      "share",
      "remove",
    ]);
  });

  it("shows Unpin and Stop reading for their current state", () => {
    const labels = messageMenu({ ...base, pinned: true, reading: true }).map((i) => i.label);
    expect(labels).toContain("Unpin");
    expect(labels).toContain("Stop reading");
    expect(labels).not.toContain("Pin");
  });

  it("offers only reading and sharing while offline", () => {
    expect(keys({ markable: false, branch: false, forward: false })).toEqual([
      "copy",
      "read",
      "share",
    ]);
  });

  it("lets a pinned message be unpinned even when it can't be marked again", () => {
    expect(keys({ markable: false, pinned: true, branch: false, forward: false })).toContain(
      "unpin",
    );
  });

  it("drops Copy and Share for a message with no words", () => {
    expect(keys({ hasText: false })).not.toContain("copy");
    expect(keys({ hasText: false })).not.toContain("share");
  });
});

describe("messageTime", () => {
  const now = new Date(2026, 10, 21, 15, 0);
  const at = (d: Date) => d.toISOString();
  it("shows only the time today", () => {
    expect(messageTime(at(new Date(2026, 10, 21, 9, 5)), now, "en-US")).toBe("9:05 AM");
  });
  it("adds the weekday within the week, the date before that", () => {
    expect(messageTime(at(new Date(2026, 10, 19, 9, 5)), now, "en-US")).toBe("Thu 9:05 AM");
    expect(messageTime(at(new Date(2026, 9, 2, 9, 5)), now, "en-US")).toBe("Oct 2, 9:05 AM");
    expect(messageTime(at(new Date(2025, 9, 2, 9, 5)), now, "en-US")).toBe("Oct 2, 2025, 9:05 AM");
  });
  it("is empty without a valid time", () => {
    expect(messageTime(undefined, now)).toBe("");
    expect(messageTime("soon", now)).toBe("");
  });
});
