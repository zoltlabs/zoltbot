import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDetail } from "../../../shared/channels";
import { mentionAt, mentionedMembers, stateAfter } from "../channels";
import { createChannelsStore } from "../channels-store";
import { ChannelPage } from "./ChannelPage";

const at = new Date(Date.now() - 5 * 60_000).toISOString();
const DETAIL: ChannelDetail = {
  channel: {
    id: "payments",
    projectId: "acme",
    kind: "team",
    name: "payments",
    leadThreadId: "lead",
    memberCount: 3,
    activeRequests: 1,
  },
  members: [
    { threadId: "lead", name: "Payments", lead: true },
    { threadId: "mira", name: "Mira", lead: false },
    { threadId: "theo", name: "Theo", lead: false },
  ],
  posts: [
    {
      id: "p1",
      author: { kind: "owner" },
      text: "Ship refunds by Friday.",
      to: ["Payments"],
      requestId: "request-p1",
      question: false,
      createdAt: at,
    },
    {
      id: "p2",
      author: { kind: "member", threadId: "lead", name: "Payments" },
      text: "@Theo can you write the tests?",
      to: ["Theo"],
      requestId: "request-p1",
      question: true,
      createdAt: at,
    },
  ],
  requests: [
    {
      id: "request-p1",
      title: "Ship refunds by Friday.",
      state: "running",
      revision: 2,
      leadThreadId: "lead",
      leadName: "Payments",
      tasks: [{ id: "t1", title: "Refund endpoint", state: "running", threadId: "mira" }],
      createdAt: at,
    },
  ],
  waiting: [{ postId: "p2", threadId: "theo", name: "Theo", askedBy: "Payments", since: at }],
  more: false,
};

const agent = {
  listChannels: vi.fn(),
  readChannel: vi.fn(),
  postChannel: vi.fn(),
  channelRequest: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
};

function renderPage() {
  const onOpenChat = vi.fn();
  render(() => {
    const store = createChannelsStore();
    store.open("payments");
    return (
      <ChannelPage
        store={store}
        sidebarCollapsed={false}
        onShowSidebar={() => undefined}
        onOpenChat={onOpenChat}
      />
    );
  });
  return { onOpenChat };
}

describe("ChannelPage", () => {
  beforeEach(() => {
    agent.listChannels.mockReset().mockResolvedValue([DETAIL.channel]);
    agent.readChannel.mockReset().mockResolvedValue(DETAIL);
    agent.postChannel.mockReset().mockResolvedValue(undefined);
    agent.channelRequest.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "openbot", { configurable: true, value: { agent } });
  });

  it("shows speakers, the lead, the request and who owes a reply", async () => {
    const { onOpenChat } = renderPage();
    expect(await screen.findByRole("heading", { name: "#payments" })).toBeVisible();
    const posts = screen.getByRole("list", { name: "Posts" });
    expect(within(posts).getByText("You")).toBeVisible();
    expect(within(posts).getByText("Lead")).toBeVisible();
    expect(within(posts).getByText("Refund endpoint · Running")).toBeVisible();
    const bar = screen.getByRole("region", { name: "Current request" });
    expect(within(bar).getByText("Running · Payments · 1 task")).toBeVisible();
    const waiting = screen.getByRole("region", { name: "Waiting for replies" });
    expect(waiting.textContent).toContain("Theo owes Payments a reply");
    await fireEvent.click(within(posts).getByRole("button", { name: "Payments" }));
    expect(onOpenChat).toHaveBeenCalledWith("lead");
  });

  it("completes @mentions from the keyboard and shows the post at once", async () => {
    let finish: () => void = () => undefined;
    agent.postChannel.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    renderPage();
    const input = (await screen.findByRole("combobox", {
      name: "Message #payments",
    })) as HTMLTextAreaElement;
    input.value = "@T";
    input.setSelectionRange(2, 2);
    await fireEvent.input(input);
    const list = screen.getByRole("listbox", { name: "Members" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Theo"]);
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("@Theo ");
    input.value = "@Theo please start";
    input.setSelectionRange(input.value.length, input.value.length);
    await fireEvent.input(input);
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("@Theo please start")).toBeVisible();
    expect(screen.getAllByText("to Theo")).toHaveLength(2);
    expect(agent.postChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "payments",
        text: "@Theo please start",
        mentions: ["theo"],
      }),
    );
    finish();
  });

  it("asks before stopping a request with running tasks", async () => {
    renderPage();
    const bar = await screen.findByRole("region", { name: "Current request" });
    await fireEvent.click(within(bar).getByRole("button", { name: "Stop" }));
    expect(agent.channelRequest).not.toHaveBeenCalled();
    expect(within(bar).getByText("Stops 1 task.")).toBeVisible();
    await fireEvent.click(within(bar).getByRole("button", { name: "Stop request" }));
    await waitFor(() =>
      expect(agent.channelRequest).toHaveBeenCalledWith({
        requestId: "request-p1",
        action: "stop",
        revision: 2,
      }),
    );
    expect(within(bar).getByText(/^Stopped/)).toBeVisible();
    expect(within(bar).getByRole("button", { name: "Resume" })).toBeVisible();
  });

  it("rolls back a refused post with an error", async () => {
    agent.postChannel.mockRejectedValue(new Error("mention_not_member"));
    renderPage();
    const input = (await screen.findByRole("combobox", {
      name: "Message #payments",
    })) as HTMLTextAreaElement;
    input.value = "hello";
    await fireEvent.input(input);
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Mention someone in this channel.");
    expect(screen.queryByText("hello", { selector: "p" })).toBeNull();
    expect(input.value).toBe("hello");
  });
});

describe("channel helpers", () => {
  it("finds the mention being typed and the members a post names", () => {
    expect(mentionAt("hi @Mi", 6)).toEqual({ query: "Mi", start: 3, end: 6 });
    expect(mentionAt("mail@x", 6)).toBeNull();
    const members = DETAIL.members;
    expect(mentionedMembers("@Mira and @Theo, not @Sam", members)).toEqual(["mira", "theo"]);
    expect(mentionedMembers("email@Mira.dev", members)).toEqual([]);
  });

  it("predicts the state after an action", () => {
    const request = DETAIL.requests[0];
    if (!request) throw new Error("missing request");
    expect(stateAfter(request, "stop")).toBe("stopped");
    expect(stateAfter(request, "archive")).toBe("archived");
    expect(stateAfter(request, "reassign")).toBe("running");
  });
});
