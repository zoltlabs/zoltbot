import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaletteItem } from "../palette";
import { CommandPalette } from "./CommandPalette";

function setup() {
  const openTasks = vi.fn();
  const openChat = vi.fn();
  const items: PaletteItem[] = [
    { id: "chat:1", group: "chats", label: "Release notes", detail: "Website", run: openChat },
    { id: "page:tasks", group: "pages", label: "Tasks", run: openTasks },
  ];
  const [open, setOpen] = createSignal(false);
  render(() => (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <Show when={open()}>
        <CommandPalette items={() => items} onClose={() => setOpen(false)} />
      </Show>
    </>
  ));
  return { openTasks, openChat, open };
}

describe("CommandPalette", () => {
  beforeEach(() => localStorage.clear());

  it("searches, moves with the arrows and runs the chosen item", async () => {
    const { openTasks, openChat } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));
    const input = screen.getByRole("combobox", { name: "Command palette" });
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.getByRole("group", { name: "Chats" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Pages" })).toBeVisible();

    fireEvent.input(input, { target: { value: "tas" } });
    expect(screen.queryByRole("option", { name: /Release notes/ })).toBeNull();
    expect(screen.getByRole("option", { name: "Tasks" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openTasks).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open palette" }));
    const again = screen.getByRole("combobox", { name: "Command palette" });
    expect(screen.getByRole("group", { name: "Recent" })).toHaveTextContent("Tasks");
    fireEvent.keyDown(again, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /Release notes/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(again, { key: "Enter" });
    expect(openChat).toHaveBeenCalledOnce();
  });

  it("says when nothing matches and closes with Escape, returning focus", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Open palette" });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByRole("combobox", { name: "Command palette" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.input(input, { target: { value: "zzz" } });
    expect(screen.getByRole("status")).toHaveTextContent("Nothing matches “zzz”");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
