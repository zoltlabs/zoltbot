import { describe, expect, it, vi } from "vitest";
import type { BotProfile } from "../../data";
import { chatMenuItems } from "./AgentMenus";

const bot = (fields: Partial<BotProfile>) => ({ id: "b", name: "Zolt", ...fields }) as BotProfile;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("chatMenuItems", () => {
  it("offers Clear instead of Pin and Archive for Zolt", () => {
    const run = vi.fn();
    const items = chatMenuItems(
      bot({ companyRole: "chief" }),
      { unread: false, working: false },
      run,
    );
    expect(ids(items)).toEqual(["markUnread", "mute", "clear"]);
    items.at(-1)?.run();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }), "clear");
  });

  it("waits for Zolt to finish before offering Clear", () => {
    const items = chatMenuItems(
      bot({ companyRole: "chief" }),
      { unread: true, working: true },
      vi.fn(),
    );
    expect(ids(items)).toEqual(["markRead", "mute"]);
  });

  it("keeps Archive for plain chats and nothing for managers", () => {
    expect(ids(chatMenuItems(bot({}), { unread: false, working: false }, vi.fn()))).toContain(
      "archive",
    );
    expect(
      chatMenuItems(bot({ companyRole: "manager" }), { unread: false, working: false }, vi.fn()),
    ).toEqual([]);
  });
});
