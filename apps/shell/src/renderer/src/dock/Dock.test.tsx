import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import type { DockState } from "../../../shared/dock";
import { Dock } from "./Dock";

const state: DockState = {
  position: "right",
  agents: [
    {
      id: "a",
      name: "Research",
      avatarShape: "blob",
      avatarColor: "cyan",
      working: true,
      waiting: false,
    },
  ],
  needsYou: 2,
  expanded: null,
};

function stubApi() {
  let push: (next: DockState) => void = () => undefined;
  const dock = {
    getState: vi.fn(async () => state),
    onState: (listener: (next: DockState) => void) => {
      push = listener;
      return () => undefined;
    },
    expand: vi.fn(async (botId: string | null) => push({ ...state, expanded: botId })),
    openChat: vi.fn(async () => undefined),
    onShowChat: () => () => undefined,
  };
  const agent = {
    readConversation: vi.fn(async () => ({
      botId: "a",
      messages: [
        {
          id: "1",
          author: "assistant",
          text: "Draft is ready",
          createdAt: "",
          status: "completed",
        },
      ],
    })),
    sendMessage: vi.fn(async () => ({})),
    onEvent: () => () => undefined,
  };
  Object.assign(window, { openbot: { dock, agent } });
  return { dock, agent };
}

afterEach(() => {
  Reflect.deleteProperty(window, "openbot");
});

it("opens a mini chat, sends from it and opens the full chat on a second click", async () => {
  const { dock, agent } = stubApi();
  render(() => <Dock />);
  const avatar = await screen.findByRole("button", { name: "Research, working" });
  expect(screen.getByRole("status").textContent).toContain("2 need you");
  fireEvent.click(avatar);
  expect(dock.expand).toHaveBeenCalledWith("a");
  await screen.findByText("Draft is ready");
  const composer = screen.getByRole("textbox", { name: "Message Research" });
  fireEvent.input(composer, { target: { value: "Ship it" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  await waitFor(() =>
    expect(agent.sendMessage).toHaveBeenCalledWith({
      botId: "a",
      text: "Ship it",
      attachmentDraftIds: [],
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Research, working" }));
  expect(dock.openChat).toHaveBeenCalledWith("a");
});
