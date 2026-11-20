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
  readEarlierPosts: vi.fn(),
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
    agent.readEarlierPosts.mockReset();
    agent.postChannel.mockReset().mockResolvedValue(undefined);
    agent.channelRequest.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(window, "openbot", { configurable: true, value: { agent } });
  });

  it("shows speakers, the lead and the requests", async () => {
    const { onOpenChat } = renderPage();
    expect(await screen.findByRole("heading", { name: "#payments" })).toBeVisible();
    const posts = screen.getByRole("list", { name: "Posts" });
    expect(within(posts).getByText("You")).toBeVisible();
    expect(within(posts).getByText("Lead")).toBeVisible();
    expect(within(posts).getByText("Refund endpoint · Running")).toBeVisible();
    const details = screen.getByRole("complementary", { name: "Channel details" });
    expect(within(details).getByText("Running · Payments · 1 task")).toBeVisible();
    expect(screen.queryByText(/owes .* a reply/)).toBeNull();
    await fireEvent.click(within(posts).getByRole("button", { name: "Payments" }));
    expect(onOpenChat).toHaveBeenCalledWith("lead");
  });

  it("pages back with Show earlier until the first post", async () => {
    const post = (id: string, text: string) => ({ ...DETAIL.posts[0], id, text, requestId: null });
    agent.readChannel.mockResolvedValue({ ...DETAIL, more: true });
    agent.readEarlierPosts
      .mockResolvedValueOnce({ ...DETAIL, posts: [post("p0", "Second post")], more: true })
      .mockResolvedValueOnce({ ...DETAIL, posts: [post("p-1", "First post")], more: false });
    renderPage();
    const earlier = await screen.findByRole("button", { name: "Show earlier" });
    await fireEvent.click(earlier);
    await screen.findByText("Second post");
    expect(agent.readEarlierPosts).toHaveBeenCalledWith({ channelId: "payments", before: "p1" });
    await fireEvent.click(screen.getByRole("button", { name: "Show earlier" }));
    await screen.findByText("First post");
    expect(agent.readEarlierPosts).toHaveBeenLastCalledWith({
      channelId: "payments",
      before: "p0",
    });
    const posts = screen.getByRole("list", { name: "Posts" });
    expect(posts.textContent?.indexOf("First post")).toBeLessThan(
      posts.textContent?.indexOf("Second post") ?? 0,
    );
    expect(screen.queryByRole("button", { name: "Show earlier" })).toBeNull();
  });

  it("completes @mentions from the keyboard and shows the post at once", async () => {
    let finish: () => void = () => undefined;
    agent.postChannel.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    renderPage();
    const input = (await screen.findByRole("textbox", {
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

  it("stops and resumes a request from the details panel", async () => {
    renderPage();
    const details = await screen.findByRole("complementary", { name: "Channel details" });
    await fireEvent.click(within(details).getByRole("button", { name: /^Stop / }));
    await waitFor(() =>
      expect(agent.channelRequest).toHaveBeenCalledWith({
        requestId: "request-p1",
        action: "stop",
        revision: 2,
      }),
    );
    expect(within(details).getByText(/^Stopped/)).toBeVisible();
    expect(within(details).getByRole("button", { name: /^Resume / })).toBeVisible();
  });

  it("rolls back a refused post with an error", async () => {
    agent.postChannel.mockRejectedValue(new Error("mention_not_member"));
    renderPage();
    const input = (await screen.findByRole("textbox", {
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
