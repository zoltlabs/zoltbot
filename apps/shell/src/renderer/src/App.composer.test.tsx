import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  attachment,
  confirmOnboardingModel,
  emitAgentEvent,
  emitAttachmentImport,
  setUpAppTest,
} from "./app-test-harness";

describe("Zoltbot connected desktop shell", () => {
  beforeEach(setUpAppTest);

  it("queues from the composer and clears only after success", async () => {
    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Run this Monday";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Run this Monday",
        attachmentDraftIds: [],
      }),
    );
    await waitFor(() => expect(composer).toHaveTextContent(""));
  });

  it("shows the first queued message and closes onboarding when the send event arrives", async () => {
    vi.mocked(window.openbot.agent.sendMessage).mockImplementationOnce(async (input) => {
      emitAgentEvent?.({
        type: "conversation",
        snapshot: {
          botId: input.botId,
          threadId: "thread-chief",
          activeTurnId: null,
          revision: 1,
          messages: [
            {
              id: "delivery-visible",
              author: "user",
              text: input.text,
              createdAt: "2026-08-14T12:00:00.000Z",
              status: "completed",
              delivery: { id: "delivery-visible", status: "queued", position: 1 },
            },
          ],
        },
      });
      // The service follows each send with the chat's queue.
      emitAgentEvent?.({
        type: "queue-changed",
        snapshot: {
          botId: input.botId,
          paused: false,
          deliveries: [
            {
              id: "delivery-visible",
              messageId: "delivery-visible",
              recipientBotId: input.botId,
              sender: { kind: "user" },
              text: input.text,
              attachments: [],
              replyToMessageId: null,
              status: "queued",
              position: 1,
              turnId: null,
              error: null,
              createdAt: "2026-08-14T12:00:00.000Z",
            },
          ],
        },
      });
      return {
        messageId: "message-visible",
        deliveries: [
          { id: "delivery-visible", recipientBotId: input.botId, status: "queued", position: 1 },
        ],
      };
    });

    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Show this message";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });

    expect(
      await screen.findByText("Show this message", { selector: ".message-copy" }),
    ).toBeInTheDocument();
    // A new chat's first message waits for its session to start; the agent is already on it.
    expect(screen.getByRole("status", { name: "Chief is working" })).toHaveTextContent("Working");
    expect(screen.queryByText("Queued")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Choose a model to get started.")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("listbox", { name: "What do you want me helping with most?" }),
      ).not.toBeInTheDocument();
    });
  });

  it("replies to a message through the composer and keeps the reference in the queued input", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-1",
            author: "assistant",
            text: "Should I prepare the report?",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    await screen.findByText("Should I prepare the report?");
    await fireEvent.click(screen.getByRole("button", { name: "Reply to Agent message" }));
    expect(screen.getByText("Replying to Agent")).toBeInTheDocument();

    const composer = screen.getByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Yes, today please";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Yes, today please",
        attachmentDraftIds: [],
        replyToMessageId: "assistant-1",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Replying to Agent")).not.toBeInTheDocument());
  });

  it("reacts and copies from agent hover actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "assistant-actions",
            author: "assistant",
            text: "Ready to ship.",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      },
    });

    await screen.findByText("Ready to ship.");
    await fireEvent.click(screen.getByRole("button", { name: "Add reaction" }));
    await fireEvent.click(screen.getByRole("button", { name: "React with ❤️" }));
    expect(window.openbot.agent.setMessageReaction).toHaveBeenCalledWith({
      botId: "chief",
      messageId: "assistant-actions",
      emoji: "❤️",
    });

    await fireEvent.click(screen.getByRole("button", { name: "More message actions" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Ready to ship."));
  });

  it("shows agent activity without replaying existing message entrances", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const createdAt = "2026-08-12T10:00:00.000Z";
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "delivery-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
            delivery: { id: "delivery-live", status: "queued", position: 1 },
          },
        ],
      },
    });
    const firstMessage = await screen.findByText("Do the work");
    const firstMessageEntry = firstMessage.closest(".message-entry");
    expect(firstMessageEntry).not.toHaveClass("message-entry-animated");

    emitAgentEvent?.({
      type: "turn-started",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
    });
    const workingIndicator = await screen.findByRole("status", { name: "Chief is working" });

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-live",
        revision: 2,
        messages: [
          {
            id: "delivery-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
            delivery: { id: "delivery-live", status: "running", position: null },
          },
        ],
      },
    });
    expect(screen.getByText("Do the work").closest(".message-entry")).toBe(firstMessageEntry);
    expect(screen.getByText("Do the work").closest(".user-bubble")).not.toHaveTextContent(
      "Working",
    );

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: "turn-live",
        revision: 3,
        messages: [
          {
            id: "delivery-live",
            author: "user",
            text: "Do the work",
            createdAt,
            status: "completed",
            delivery: { id: "delivery-live", status: "running", position: null },
          },
          {
            id: "assistant-live",
            author: "assistant",
            text: "I am on it",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "streaming",
          },
        ],
      },
    });
    const streamingAnswer = await screen.findByText("I am on it");
    const streamingBubble = streamingAnswer.closest(".bot-bubble");
    expect(streamingAnswer.closest(".message-entry")).toHaveClass("message-entry-animated");
    expect(streamingBubble).toHaveClass("bot-bubble-streaming");
    expect(screen.queryByText("Typing…")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Chief is working" })).toBe(workingIndicator);

    emitAgentEvent?.({
      type: "conversation-delta",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      messageId: "assistant-live",
      delta: " now",
      createdAt: "2026-08-12T10:00:01.000Z",
      revision: 4,
    });
    const updatedStreamingAnswer = await screen.findByText("I am on it now");
    expect(updatedStreamingAnswer.closest(".bot-bubble")).toBe(streamingBubble);
    expect(screen.getByText("Do the work").closest(".message-entry")).toBe(firstMessageEntry);
    expect(screen.getByRole("status", { name: "Chief is working" })).toBe(workingIndicator);

    for (const [revision, text] of [
      [5, "I am on it now, first buffered delta"],
      [6, "I am on it now, final buffered delta"],
    ] as const) {
      emitAgentEvent?.({
        type: "conversation",
        snapshot: {
          botId: "chief",
          threadId: "thread-chief",
          activeTurnId: "turn-live",
          revision,
          messages: [
            {
              id: "delivery-live",
              author: "user",
              text: "Do the work",
              createdAt,
              status: "completed",
              delivery: { id: "delivery-live", status: "running", position: null },
            },
            {
              id: "assistant-live",
              author: "assistant",
              text,
              createdAt: "2026-08-12T10:00:01.000Z",
              status: "streaming",
            },
          ],
        },
      });
    }
    const bufferedAnswer = await screen.findByText("I am on it now, final buffered delta");
    expect(bufferedAnswer.closest(".bot-bubble")).toBe(streamingBubble);
    expect(screen.queryByText("I am on it now, first buffered delta")).not.toBeInTheDocument();

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-live",
      status: "completed",
    });
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Chief is working" })).not.toBeInTheDocument(),
    );
    expect(document.querySelector(".agent-activity-entry")).toBe(workingIndicator);
    expect(workingIndicator).toHaveAttribute("aria-hidden", "true");
  });

  it("groups commentary into a collapsed thinking disclosure", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "user-open",
            turnId: "turn-open",
            author: "user",
            text: "Open x.com",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "commentary-open",
            turnId: "turn-open",
            author: "assistant",
            text: "I’ll open x.com in the Zoltbot browser.",
            createdAt: "2026-08-12T10:00:01.000Z",
            status: "completed",
            itemType: "commentary",
          },
          {
            id: "commentary-check",
            turnId: "turn-open",
            author: "assistant",
            text: "Checking that the page loaded.",
            createdAt: "2026-08-12T10:00:02.000Z",
            status: "completed",
            itemType: "commentary",
          },
          {
            id: "answer-open",
            turnId: "turn-open",
            author: "assistant",
            text: "Opened x.com.",
            createdAt: "2026-08-12T10:00:03.000Z",
            status: "completed",
            itemType: "final_answer",
          },
        ],
      },
    });

    const thinkingLabel = await screen.findByText("Thinking");
    const details = thinkingLabel.closest("details");
    expect(screen.getByText("I’ll open x.com in the Zoltbot browser.")).not.toBeVisible();
    expect(screen.getByText("Checking that the page loaded.")).not.toBeVisible();
    expect(screen.getByText("Opened x.com.")).toBeVisible();
    expect(screen.getAllByText("Thinking")).toHaveLength(1);

    await fireEvent.click(thinkingLabel);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("I’ll open x.com in the Zoltbot browser.")).toBeVisible();

    emitAgentEvent?.({
      type: "conversation",
      snapshot: {
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 2,
        messages: [
          {
            id: "user-open",
            turnId: "turn-open",
            author: "user",
            text: "Open x.com",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
          {
            id: "answer-open",
            turnId: "turn-open",
            author: "assistant",
            text: "Opened x.com.",
            createdAt: "2026-08-12T10:00:03.000Z",
            status: "completed",
            itemType: "final_answer",
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByText("Thinking").closest("details")).toBe(details));
    expect(screen.getByText("I’ll open x.com in the Zoltbot browser.")).toBeVisible();
  });

  it("keeps text and attachments when enqueue fails", async () => {
    vi.mocked(window.openbot.agent.sendMessage).mockRejectedValueOnce(
      new Error("Mailbox unavailable"),
    );
    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Retry me";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    expect(await screen.findByText("Mailbox unavailable")).toBeInTheDocument();
    await waitFor(() => expect(composer).toHaveTextContent("Retry me"));
  });

  it("clears the composer as soon as a message is sent", async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(window.openbot.agent.sendMessage).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
    );
    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Start now";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(composer).toHaveTextContent(""));
    expect(composer).toHaveAttribute("contenteditable", "true");
    finish({ messageId: "m1", deliveries: [] });
  });

  it("puts a stopped message back without an error", async () => {
    vi.mocked(window.openbot.agent.sendMessage).mockRejectedValueOnce(new Error("Stopped."));
    render(() => <App />);
    await confirmOnboardingModel();
    const composer = await screen.findByRole("textbox", { name: "Message Chief" });
    composer.textContent = "Never mind";
    await fireEvent.input(composer);
    await fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(composer).toHaveTextContent("Never mind"));
    expect(screen.queryByText("Stopped.")).not.toBeInTheDocument();
  });

  it("supports picker and attachment-only messages", async () => {
    vi.mocked(window.openbot.agent.chooseAttachments).mockResolvedValueOnce([
      attachment("draft-1", "brief.pdf", "pdf"),
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await fireEvent.click(screen.getByRole("button", { name: "Attach a file" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Attach files" }));
    expect(await screen.findByText("brief.pdf")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "",
        attachmentDraftIds: ["draft-1"],
      }),
    );
  });

  it("adds pathless pasted images reported by preload", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started", requestId: "paste-1" });
    emitAttachmentImport?.({
      type: "completed",
      requestId: "paste-1",
      attachments: [attachment("pasted-1", "pasted.png", "image")],
    });
    expect(await screen.findByText("pasted.png")).toBeInTheDocument();
  });

  it("keeps an asynchronous pasted attachment with the bot that received the paste", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAttachmentImport?.({ type: "started", requestId: "paste-switch" });
    await fireEvent.click(screen.getByRole("button", { name: /^Sales Outbound/ }));
    emitAttachmentImport?.({
      type: "completed",
      requestId: "paste-switch",
      attachments: [attachment("pasted-switch", "for-chief.png", "image")],
    });

    expect(screen.queryByText("for-chief.png")).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: /^Chief/ }));
    expect(await screen.findByText("for-chief.png")).toBeInTheDocument();
  });

  it("shows and controls queued work", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        paused: true,
        deliveries: [
          {
            id: "delivery-1",
            messageId: "message-1",
            recipientBotId: "chief",
            sender: { kind: "user" },
            text: "Later",
            attachments: [],
            replyToMessageId: null,
            status: "queued",
            position: 1,
            turnId: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    const delivery = (id: string, text: string, position: number) => ({
      id,
      messageId: id,
      recipientBotId: "chief",
      sender: { kind: "user" as const },
      text,
      attachments: [],
      replyToMessageId: null,
      status: "queued" as const,
      position,
      turnId: null,
      error: null,
      createdAt: new Date().toISOString(),
      editable: true,
    });
    emitAgentEvent?.({
      type: "queue-changed",
      snapshot: {
        botId: "chief",
        paused: false,
        deliveries: [delivery("delivery-1", "Later", 1), delivery("delivery-2", "Then this", 2)],
      },
    });
    expect(await screen.findByRole("heading", { name: "2 queued" })).toBeTruthy();

    // Alt+↓ on the handle moves the row at once and sends the new order.
    await fireEvent.keyDown(screen.getByRole("button", { name: "Move Later" }), {
      key: "ArrowDown",
      altKey: true,
    });
    expect(window.openbot.queue.reorder).toHaveBeenCalledWith({
      botId: "chief",
      order: ["delivery-2", "delivery-1"],
    });
    const rows = () => screen.getAllByRole("listitem").map((row) => row.textContent?.trim() ?? "");
    expect(rows().filter((row) => row === "Later" || row === "Then this")).toEqual([
      "Then this",
      "Later",
    ]);

    await fireEvent.click(screen.getByRole("button", { name: "Actions for Later" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: /Send now/ }));
    expect(window.openbot.queue.sendNow).toHaveBeenCalledWith({
      botId: "chief",
      deliveryId: "delivery-1",
    });

    await fireEvent.click(screen.getByRole("button", { name: "Actions for Then this" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: /Remove/ }));
    expect(window.openbot.agent.cancelQueuedMessage).toHaveBeenCalledWith({
      botId: "chief",
      deliveryId: "delivery-2",
    });

    // Edit takes the message out of the queue and back into the composer.
    await fireEvent.click(screen.getByRole("button", { name: "Actions for Later" }));
    await fireEvent.click(await screen.findByRole("menuitem", { name: /Edit/ }));
    await waitFor(() =>
      expect(window.openbot.agent.cancelQueuedMessage).toHaveBeenCalledWith({
        botId: "chief",
        deliveryId: "delivery-1",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /Message Chief/ }).textContent).toContain("Later"),
    );
    expect(window.openbot.agent.setQueuePaused).toHaveBeenCalledWith({
      botId: "chief",
      paused: false,
    });
  });

  it("persists the onboarding focus before queuing the first user message", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await fireEvent.click(screen.getByRole("option", { name: /Work & projects/ }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        role: "Work & projects",
        description:
          "Helps plan, organize, and execute ongoing work and projects while keeping priorities, next steps, and deliverables clear.",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
      }),
    );
    await waitFor(() =>
      expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
        botId: "chief",
        text: "Focus on my work and projects. Help me plan, organize, and execute them proactively.",
        attachmentDraftIds: [],
      }),
    );
    expect(vi.mocked(window.openbot.agent.updateBot).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.openbot.agent.sendMessage).mock.invocationCallOrder[0] ?? Number.MAX_VALUE,
    );
  });

  it("uses a custom onboarding answer as the persistent agent remit", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    await fireEvent.click(await screen.findByRole("option", { name: /Something else/ }));
    expect(window.openbot.agent.sendMessage).not.toHaveBeenCalled();

    const customAnswer = screen.getByRole("textbox", { name: "Custom answer" });
    expect(customAnswer).toHaveFocus();
    await fireEvent.input(customAnswer, { target: { value: "Plan product launches" } });
    await fireEvent.keyDown(customAnswer, { key: "Enter" });

    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        role: "Plan product launches",
        description: "Primary focus: Plan product launches.",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
      }),
    );
    expect(window.openbot.agent.sendMessage).toHaveBeenCalledWith({
      botId: "chief",
      text: "My main focus for you is: Plan product launches. Treat this as your ongoing specialty.",
      attachmentDraftIds: [],
    });
  });

  it("answers model prompts from a separate card while composer remains a queue", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await confirmOnboardingModel();
    emitAgentEvent?.({
      type: "prompt",
      requestId: "prompt-1",
      botId: "chief",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: "account",
          header: "Account",
          question: "Which account?",
          isSecret: false,
          options: null,
        },
      ],
    });
    const answer = await screen.findByRole("textbox", { name: "Account" });
    await fireEvent.input(answer, { target: { value: "Acme" } });
    await fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(window.openbot.agent.respondToPrompt).toHaveBeenCalledWith({
        requestId: "prompt-1",
        answers: { account: ["Acme"] },
      }),
    );
  });
});
