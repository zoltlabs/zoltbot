// S9: the sidebar's Unread group, row menu actions and sort menu.
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { BOTS, setUpAppTest } from "./app-test-harness";
import { ToastRegion } from "./kit";

const unreadBots = () => [
  { ...BOTS[0], updatedAt: "2026-01-01T00:00:00Z" },
  { ...BOTS[1], unread: true, pinned: true, updatedAt: "2026-01-02T00:00:00Z" },
];

async function sidebar() {
  render(() => (
    <>
      <App />
      <ToastRegion />
    </>
  ));
  await screen.findByRole("heading", { name: "Chief" });
  return screen.getByRole("complementary", { name: "Bot navigation" });
}

describe("sidebar sort, filter and unread", () => {
  beforeEach(() => {
    setUpAppTest();
    vi.mocked(window.openbot.agent.listBots).mockResolvedValue(unreadBots());
  });

  it("shows unread chats first, under Unread", async () => {
    const nav = await sidebar();
    const list = within(nav).getByRole("navigation", { name: "Bot list" });
    await waitFor(() => expect(within(list).getByText("Unread")).toBeInTheDocument());
    const rows = within(list)
      .getAllByRole("button", { pressed: false })
      .map((row) => row.textContent);
    expect(rows[0]).toContain("Sales Outbound");
  });

  it("marks read, unpins and archives with Undo from the row menu", async () => {
    const nav = await sidebar();
    const actions = await within(nav).findByRole("button", { name: "Actions for Sales Outbound" });
    const choose = async (name: string) => {
      fireEvent.click(actions);
      fireEvent.click(await screen.findByRole("menuitem", { name }));
    };
    await choose("Mark read");
    await choose("Unpin");
    await choose("Archive");
    const call = vi.mocked(window.openbot.agent.threadAction).mock.calls.map(([input]) => input);
    expect(call).toEqual([
      { botId: "sales-outbound", action: "markRead" },
      { botId: "sales-outbound", action: "unpin" },
      { botId: "sales-outbound", action: "archive" },
    ]);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(window.openbot.agent.threadAction).toHaveBeenLastCalledWith({
      botId: "sales-outbound",
      action: "unarchive",
    });
  });

  it("marks the open chat read", async () => {
    // Reading only counts while the window has focus.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.mocked(window.openbot.agent.listBots).mockResolvedValue([
      { ...BOTS[0], unread: true },
      BOTS[1],
    ]);
    await sidebar();
    await waitFor(() =>
      expect(window.openbot.agent.threadAction).toHaveBeenCalledWith({
        botId: "chief",
        action: "markRead",
      }),
    );
  });

  it("sorts by name and remembers it, dropping the Unread group", async () => {
    const nav = await sidebar();
    fireEvent.click(within(nav).getByRole("button", { name: "Sort and filter" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Name" }));
    await waitFor(() => expect(within(nav).queryByText("Unread")).not.toBeInTheDocument());
    expect(window.localStorage.getItem("zoltbot.sidebar.sort")).toBe("name");
  });
});
