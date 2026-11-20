import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotMessage, BotProfile } from "../../data";
import {
  BranchBanner,
  BranchList,
  branchesByMessage,
  branchPoint,
  createBranching,
} from "./Branching";

const bot = { id: "chat", name: "Release notes" } as BotProfile;
const answer: BotMessage = { id: "m2", author: "bot", body: "Done.", time: "", turnId: "t1" };
const asked: BotMessage = { id: "m1", author: "you", body: "Draft it", time: "", turnId: "t1" };

function setup() {
  const onOpenChat = vi.fn();
  const onDraft = vi.fn();
  let branching!: ReturnType<typeof createBranching>;
  render(() => {
    branching = createBranching({ bot: () => bot, onOpenChat, onDraft });
    return <>{branching.view()}</>;
  });
  return { branching, onOpenChat, onDraft };
}

describe("branching", () => {
  beforeEach(() => {
    window.openbot = {
      agent: {
        branchPreview: vi.fn().mockResolvedValue({
          available: true,
          kind: "copied",
          copiedMessages: 2,
          omittedMessages: 0,
          reason: "",
        }),
        branch: vi.fn().mockResolvedValue({ botId: "child", ready: true, failed: false }),
        createBot: vi.fn().mockResolvedValue({ id: "fresh" }),
      },
    } as unknown as typeof window.openbot;
  });

  it("starts a branch after an answer and before the owner's own message", () => {
    expect(branchPoint(answer, "branch")).toBe("after_turn");
    expect(branchPoint(asked, "branch")).toBe("before_user");
    expect(branchPoint(answer, "edit")).toBe("before_user");
  });

  it("previews the branch, makes it and opens the new chat", async () => {
    const { branching, onOpenChat, onDraft } = setup();
    branching.open(answer, "branch");
    const dialog = await screen.findByRole("dialog", { name: "Branch from this message" });
    await waitFor(() =>
      expect(dialog).toHaveTextContent("2 earlier messages go to the agent as context."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Branch" }));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("child"));
    expect(window.openbot.agent.branch).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "chat", turnId: "t1", at: "after_turn" }),
    );
    expect(onDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("edits a sent message into the new chat's draft", async () => {
    const { branching, onDraft } = setup();
    branching.open(asked, "edit");
    const text = await screen.findByRole("textbox", { name: "Message" });
    expect(text).toHaveValue("Draft it");
    fireEvent.input(text, { target: { value: "Draft it shorter" } });
    const send = screen.getByRole("button", { name: "Branch and edit" });
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(onDraft).toHaveBeenCalledWith("child", "Draft it shorter"));
  });

  it("starts a new chat when the edited message is the chat's first", async () => {
    vi.mocked(window.openbot.agent.branchPreview).mockResolvedValueOnce({
      available: false,
      kind: "copied",
      copiedMessages: 0,
      omittedMessages: 0,
      reason: "copied_history_unavailable",
    });
    const { branching, onDraft, onOpenChat } = setup();
    branching.open(asked, "edit");
    const dialog = await screen.findByRole("dialog", { name: "Edit in a new branch" });
    await waitFor(() => expect(dialog).toHaveTextContent("This starts a new chat."));
    const send = screen.getByRole("button", { name: "Branch and edit" });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("fresh"));
    expect(onDraft).toHaveBeenCalledWith("fresh", "Draft it");
    expect(window.openbot.agent.branch).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and retries the same attempt when the branch isn't confirmed", async () => {
    vi.mocked(window.openbot.agent.branch).mockResolvedValueOnce({
      botId: "child",
      ready: false,
      failed: false,
    });
    const { branching, onOpenChat } = setup();
    branching.open(answer, "branch");
    const confirm = await screen.findByRole("button", { name: "Branch" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't ready yet");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("child"));
    const attempts = vi
      .mocked(window.openbot.agent.branch)
      .mock.calls.map(([call]) => call.attemptId);
    expect(new Set(attempts).size).toBe(1);
  });

  it("starts a new attempt after one that failed", async () => {
    vi.mocked(window.openbot.agent.branch).mockResolvedValueOnce({
      botId: "",
      ready: false,
      failed: true,
    });
    const { branching, onOpenChat } = setup();
    branching.open(answer, "branch");
    const confirm = await screen.findByRole("button", { name: "Branch" });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't branch.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onOpenChat).toHaveBeenCalledWith("child"));
    const attempts = vi
      .mocked(window.openbot.agent.branch)
      .mock.calls.map(([call]) => call.attemptId);
    expect(new Set(attempts).size).toBe(2);
  });

  it("lists an edit's branch under the owner's message and others under the answer", () => {
    const origin = (at: "before_user" | "after_turn") => ({ botId: "chat", turnId: "t1", at });
    const edited = { id: "e", name: "Edited", branchedFrom: origin("before_user") } as BotProfile;
    const later = { id: "l", name: "Later", branchedFrom: origin("after_turn") } as BotProfile;
    const elsewhere = {
      id: "x",
      name: "Other",
      branchedFrom: { ...origin("after_turn"), botId: "other" },
    } as BotProfile;
    const map = branchesByMessage([edited, later, elsewhere], "chat", [asked, answer]);
    expect(map.get("m1")?.map((bot) => bot.id)).toEqual(["e"]);
    expect(map.get("m2")?.map((bot) => bot.id)).toEqual(["l"]);
  });

  it("links a branch back to its chat and lists a chat's branches", () => {
    const onOpenChat = vi.fn();
    const child = {
      id: "child",
      name: "Release notes (branch)",
      branchedFrom: { botId: "chat", turnId: "t1", at: "after_turn" },
    } as BotProfile;
    render(() => (
      <>
        <BranchBanner bot={child} bots={[bot, child]} onOpenChat={onOpenChat} />
        <BranchList branches={[child]} onOpenChat={onOpenChat} />
      </>
    ));
    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
    expect(onOpenChat).toHaveBeenCalledWith("chat");
    const count = screen.getByRole("button", { name: "1 branch" });
    expect(count).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(count);
    fireEvent.click(screen.getByRole("button", { name: "Release notes (branch)" }));
    expect(onOpenChat).toHaveBeenLastCalledWith("child");
  });
});
