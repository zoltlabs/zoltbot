import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotMessage } from "../../data";
import { dismissToast, ToastRegion } from "../../kit";
import { createMessageActionsState, MessageActions } from "./MessageActions";
import { MESSAGE_MENU, messageMenuGroups } from "./messageMenu";

const message: BotMessage = { id: "m1", author: "bot", body: "Ready to ship.", time: "10:00" };

function renderActions(onReply = vi.fn()) {
  const actions = createMessageActionsState({
    botId: () => "chief",
    onReply,
    onBranch: vi.fn(),
    onError: vi.fn(),
  });
  render(() => (
    <main>
      <article
        data-testid="message"
        onContextMenu={(event) => {
          event.preventDefault();
          const more = event.currentTarget.querySelector<HTMLElement>(".message-more-button");
          const selected = window.getSelection()?.toString() || undefined;
          actions.openMenuAt(message.id, { x: 40, y: 40 }, more ?? undefined, selected);
        }}
      >
        <p>{message.body}</p>
        <MessageActions message={message} actions={actions} />
      </article>
      <ToastRegion />
    </main>
  ));
  return actions;
}

describe("Message menu", () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.assign(window, {
      openbot: { agent: { setMessageReaction: vi.fn().mockResolvedValue(undefined) } },
    });
  });
  afterEach(() => {
    for (const status of document.querySelectorAll("[role='status']")) status.remove();
    for (let id = 0; id < 50; id++) dismissToast(id);
  });

  it("lists Reply and Copy, runs Copy from the keyboard and confirms with a toast", async () => {
    renderActions();
    const more = screen.getByRole("button", { name: "More message actions" });
    more.focus();
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "Message actions" });
    expect(more).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("menuitem").map((item) => item.dataset.label);
    expect(items).toEqual(["Reply", "Copy"]);
    expect(document.activeElement).toHaveAttribute("data-label", "Reply");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute("data-label", "Copy");
    fireEvent.click(document.activeElement as HTMLElement);

    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Ready to ship."));
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
    await waitFor(() => expect(document.activeElement).toBe(more));
  });

  it("opens the same menu on right-click and returns focus to More on Escape", async () => {
    const onReply = vi.fn();
    renderActions(onReply);
    fireEvent.contextMenu(screen.getByTestId("message"));
    expect(screen.getByRole("menu", { name: "Message actions" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "More message actions" }),
      ),
    );

    fireEvent.contextMenu(screen.getByTestId("message"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledWith(message);
  });

  it("copies the selected text when the message was right-clicked with a selection", async () => {
    renderActions();
    const paragraph = screen.getByText("Ready to ship.");
    const range = document.createRange();
    range.setStart(paragraph.firstChild as Text, 0);
    range.setEnd(paragraph.firstChild as Text, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const selection = window.getSelection()?.toString() ?? "";
    fireEvent.contextMenu(screen.getByTestId("message"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(selection));
    window.getSelection()?.removeAllRanges();
  });

  it("keeps a right-click inside the open menu from reopening it", () => {
    renderActions();
    fireEvent.contextMenu(screen.getByTestId("message"));
    const item = screen.getByRole("menuitem", { name: "Reply" });
    item.focus();
    fireEvent.contextMenu(item);
    expect(item).toHaveFocus();
  });

  it("reacts from the emoji popover and returns focus to its button", async () => {
    renderActions();
    const button = screen.getByRole("button", { name: "Add reaction" });
    fireEvent.click(button);
    const picker = screen.getByRole("dialog", { name: "Choose a reaction" });
    expect(picker).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "More emoji" }));
    fireEvent.click(screen.getByRole("button", { name: "React with ❤️" }));
    expect(window.openbot.agent.setMessageReaction).toHaveBeenCalledWith({
      botId: "chief",
      messageId: "m1",
      emoji: "❤️",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("skips entries that don't apply and keeps groups in order", () => {
    const actions = {
      reply: vi.fn(),
      copy: vi.fn(),
      branch: vi.fn(),
      isPinned: () => false,
      pin: vi.fn(),
    };
    const empty = messageMenuGroups({ ...message, body: "" }, actions);
    expect(empty.flat().map((item) => item.id)).toEqual(["reply"]);

    const entries = [
      ...MESSAGE_MENU,
      { id: "hide", label: "chat.message.copy" as const, icon: () => null, group: 2, run: vi.fn() },
      { id: "pin", label: "chat.message.reply" as const, icon: () => null, group: 1, run: vi.fn() },
    ];
    const groups = messageMenuGroups(message, actions, entries);
    expect(groups.map((group) => group.map((item) => item.id))).toEqual([
      ["reply", "copy"],
      ["pin"],
      ["hide"],
    ]);
  });

  it("offers Branch on any finished message and Edit on the owner's own", () => {
    const actions = {
      reply: vi.fn(),
      copy: vi.fn(),
      branch: vi.fn(),
      isPinned: () => false,
      pin: vi.fn(),
    };
    const ids = (entry: BotMessage) =>
      messageMenuGroups(entry, actions)
        .flat()
        .map((item) => item.id);
    expect(ids(message)).toEqual(["reply", "copy"]);
    expect(ids({ ...message, turnId: "t1" })).toEqual(["reply", "copy", "pin", "branch"]);
    expect(ids({ ...message, turnId: "t1", streaming: true })).toEqual(["reply", "copy"]);
    const own = { ...message, author: "you" as const, turnId: "t1" };
    expect(ids(own)).toEqual(["reply", "copy", "pin", "branch", "edit"]);
    for (const item of messageMenuGroups(own, actions).flat()) item.run();
    expect(actions.branch.mock.calls.map(([, mode]) => mode)).toEqual(["branch", "edit"]);
  });

  it("offers Pin on a settled message and Unpin once it is pinned", () => {
    const settled = { ...message, turnId: "t1" };
    const pin = vi.fn();
    const actions = { reply: vi.fn(), copy: vi.fn(), branch: vi.fn(), pin };
    const ids = (entry: BotMessage, pinned: boolean) =>
      messageMenuGroups(entry, { ...actions, isPinned: () => pinned })
        .flat()
        .map((item) => item.id);
    expect(ids(settled, false)).toContain("pin");
    expect(ids({ ...settled, streaming: true }, false)).not.toContain("pin");
    expect(ids(settled, true)).toContain("unpin");
    expect(ids(settled, true)).not.toContain("pin");
    messageMenuGroups(settled, { ...actions, isPinned: () => true })
      .flat()
      .find((item) => item.id === "unpin")
      ?.run();
    expect(pin).toHaveBeenCalledWith(settled, false);
  });
});
