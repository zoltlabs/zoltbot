import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { BOTS, emitAgentEvent, setUpAppTest } from "./app-test-harness";

describe("Zoltbot connected desktop shell", () => {
  beforeEach(setUpAppTest);

  it("renders loaded history without replaying entrance animations", async () => {
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValueOnce({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "stored-message",
          author: "assistant",
          text: "Already in history",
          createdAt: "2026-08-12T09:00:00.000Z",
          status: "completed",
        },
      ],
    });
    render(() => <App />);
    const stored = await screen.findByText("Already in history");
    expect(stored.closest(".message-entry")).not.toHaveClass("message-entry-animated");
  });

  it("renders message links and opens them in the embedded browser", async () => {
    vi.mocked(window.openbot.agent.readConversation).mockResolvedValueOnce({
      botId: "chief",
      threadId: "thread-chief",
      activeTurnId: null,
      revision: 1,
      messages: [
        {
          id: "linked-message",
          author: "assistant",
          text: "Read [Meta](https://about.fb.com/news/) or https://example.com/report.",
          createdAt: "2026-08-12T09:00:00.000Z",
          status: "completed",
        },
      ],
    });
    render(() => <App />);
    const metaLink = await screen.findByRole("link", { name: "Meta" });
    expect(metaLink).toHaveAttribute("href", "https://about.fb.com/news/");
    expect(metaLink.querySelector("img")).toHaveAttribute(
      "src",
      "https://about.fb.com/favicon.ico",
    );
    expect(screen.getByRole("link", { name: "https://example.com/report" })).toHaveAttribute(
      "href",
      "https://example.com/report",
    );
    expect(screen.queryByText("https://about.fb.com/news/")).not.toBeInTheDocument();

    await fireEvent.click(metaLink);
    expect(window.openbot.openUrl).toHaveBeenCalledWith("https://about.fb.com/news/");
    expect(window.openbot.browser.open).not.toHaveBeenCalled();
  });

  it("refreshes stored history when the daemon becomes ready after the window opens", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValue({
      phase: "starting",
      cliVersion: "0.144.1",
      auth: { kind: "unknown" },
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Starting Zoltbot…",
      fullAccess: true,
    });
    vi.mocked(window.openbot.agent.readConversation)
      .mockResolvedValueOnce({
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 0,
        messages: [],
      })
      .mockResolvedValueOnce({
        botId: "chief",
        threadId: "thread-chief",
        activeTurnId: null,
        revision: 1,
        messages: [
          {
            id: "restored-answer",
            author: "assistant",
            text: "Restored after the daemon became ready",
            createdAt: "2026-08-12T10:00:00.000Z",
            status: "completed",
          },
        ],
      });

    render(() => <App />);
    await screen.findByText("Connecting to Zoltbot…");
    emitAgentEvent?.({
      type: "status",
      status: {
        phase: "ready",
        cliVersion: "0.144.1",
        auth: { kind: "unknown" },
        capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
        message: null,
        fullAccess: true,
      },
    });

    expect(await screen.findByText("Restored after the daemon became ready")).toBeInTheDocument();
    expect(window.openbot.agent.readConversation).toHaveBeenCalledTimes(2);
  });

  it("filters and switches backend bots", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("button", { name: "Onboarding model: Luna" });
    const search = screen.getByRole("searchbox", { name: "Search chats" });
    await fireEvent.input(search, { target: { value: "Sales" } });
    await fireEvent.click(screen.getByRole("button", { name: /^Sales Outbound/ }));
    expect(screen.getByRole("heading", { name: "Sales Outbound" })).toBeInTheDocument();
  });

  it("opens the Tasks page from the sidebar and with Command-T", async () => {
    vi.mocked(window.openbot.agent.listTasks).mockResolvedValue([
      {
        id: "retries",
        title: "Add webhook retries",
        projectId: null,
        projectName: "",
        state: "review",
        revision: 1,
        reason: "",
        atLimit: false,
        threadId: null,
        owner: { profileId: "mira", name: "Mira" },
        teamId: null,
        teamName: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const row = await screen.findByRole("button", { name: /^Tasks.*1.*need you$/ });
    await fireEvent.click(row);
    expect(screen.getByRole("main", { name: "Tasks" })).toBeVisible();
    expect(row).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Add webhook retries")).toBeVisible();

    await fireEvent.keyDown(window, { key: "t", metaKey: true });
    expect(screen.queryByRole("main", { name: "Tasks" })).not.toBeInTheDocument();
    await fireEvent.keyDown(window, { key: "t", metaKey: true });
    expect(screen.getByRole("main", { name: "Tasks" })).toBeVisible();
  });

  it("counts pending staff approvals in the Tasks row", async () => {
    vi.mocked(window.openbot.agent.readStaff).mockResolvedValue({
      approvals: [
        {
          kind: "staff",
          requestId: "staff-approval-1",
          action: "add",
          state: "pending",
          title: "Add Nova to Payments",
          name: "Nova",
          projectId: "acme",
          botId: "mira-thread",
          requestedBy: "Mira",
          fields: [],
          moves: [],
          running: 0,
          sharedWith: 0,
          allowance: null,
        },
      ],
      people: [],
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    expect(await screen.findByRole("button", { name: /^Tasks.*1.*need you$/ })).toBeVisible();
  });

  it("opens a new agent ready to message, without OpenBot's specialty question", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "New agent" }));
    await fireEvent.click(screen.getByRole("option", { name: "Create new agent" }));

    expect(await screen.findByRole("heading", { name: "New agent" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("listbox", { name: "What do you want me helping with most?" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Message New agent")).toHaveAttribute("contenteditable", "true"),
    );
  });

  it("resizes and persists the left and right side panels", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const leftResizer = screen.getByRole("separator", { name: "Resize left sidebar" });
    await fireEvent.keyDown(leftResizer, { key: "ArrowRight" });
    expect(leftResizer).toHaveAttribute("aria-valuenow", "287");
    expect(leftResizer.closest(".app-frame")).toHaveStyle("--left-panel-width: 287px");
    expect(window.localStorage.getItem("openbot:left-panel-width")).toBe("287");

    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const rightResizer = screen.getByRole("separator", { name: "Resize right panel" });
    await fireEvent.keyDown(rightResizer, { key: "ArrowLeft" });
    expect(rightResizer).toHaveAttribute("aria-valuenow", "308");
    expect(screen.getByRole("main", { name: "Conversation" })).toHaveStyle(
      "--settings-panel-width: 308px",
    );
    expect(window.localStorage.getItem("openbot:settings-panel-width")).toBe("308");

    await fireEvent.dblClick(rightResizer);
    expect(rightResizer).toHaveAttribute("aria-valuenow", "296");

    await fireEvent.keyDown(rightResizer, { key: "Home" });
    expect(rightResizer).toHaveAttribute("aria-valuenow", "180");
    await fireEvent.keyDown(rightResizer, { key: "End" });
    expect(rightResizer).toHaveAttribute(
      "aria-valuenow",
      String(Math.min(1600, window.innerWidth - 96)),
    );
  });

  it("selects a provider and model from the conversation header", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });
    expect(trigger.querySelector(".provider-model-mark-codex")).toBeInTheDocument();
    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    expect(within(picker).getByText("0.144.1")).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Luna, default" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    expect(window.openbot.agent.updateBot).not.toHaveBeenCalled();
    expect(within(picker).getByText("2.1.231")).toBeInTheDocument();
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));

    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        model: "claude-opus-5",
        reasoningEffort: "medium",
      }),
    );
    expect(screen.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
    const claudeTrigger = await screen.findByRole("button", {
      name: "Agent model: Claude Opus 5",
    });
    expect(claudeTrigger).toBeEnabled();
    expect(claudeTrigger.querySelector(".provider-model-mark-claude")).toBeInTheDocument();
    expect(claudeTrigger.querySelector(".provider-model-mark-codex")).not.toBeInTheDocument();
  });

  it("shows unavailable providers without allowing their models", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "ready",
      cliVersion: "0.144.1",
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "available", version: "0.144.1", message: null },
        {
          id: "claude",
          state: "not-installed",
          version: null,
          message: "Claude CLI was not found.",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(
      within(picker).getByRole("tab", { name: /Claude: Claude CLI was not found/ }),
    );
    expect(within(picker).getByText("Claude CLI was not found.")).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Claude Opus 5, default" })).toBeDisabled();
    expect(window.openbot.agent.updateBot).not.toHaveBeenCalled();
  });

  it("rolls back a failed header model change and reports the error", async () => {
    vi.mocked(window.openbot.agent.updateBot).mockRejectedValueOnce(new Error("Provider failed"));
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await screen.findByRole("button", { name: "Onboarding model: Luna" });

    await fireEvent.click(screen.getByRole("button", { name: "Agent model: Luna" }));
    await fireEvent.click(screen.getByRole("option", { name: "Sol" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not change model. Try again.",
    );
    expect(screen.getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
    expect(
      screen.queryByRole("listbox", { name: "What do you want me helping with most?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "false");
  });

  it("locks the header model picker during active work", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });

    emitAgentEvent?.({
      type: "turn-started",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
    });
    await waitFor(() => expect(trigger).toBeDisabled());
    expect(trigger).toHaveAttribute(
      "title",
      "Wait for the current work to finish before changing models.",
    );

    emitAgentEvent?.({
      type: "turn-completed",
      botId: "chief",
      threadId: "thread-chief",
      turnId: "turn-1",
      status: "completed",
    });
    await waitFor(() => expect(trigger).toBeEnabled());
  });

  it("supports picker keyboard navigation and outside dismissal", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    const trigger = screen.getByRole("button", { name: "Agent model: Luna" });

    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    const codex = within(picker).getByRole("tab", { name: /^Codex:/ });
    await fireEvent.keyDown(codex, { key: "ArrowUp" });
    const claude = within(picker).getByRole("tab", { name: /^Claude:/ });
    expect(claude).toHaveFocus();
    expect(claude).toHaveAttribute("aria-selected", "true");

    await fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
    await fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Choose agent model" })).toBeInTheDocument();
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Choose agent model" })).not.toBeInTheDocument();
  });

  it("edits the persisted model and thinking level in agent settings", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));

    const settings = screen.getByRole("complementary", { name: "Agent settings" });
    expect(within(settings).getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();
    expect(
      within(settings).getByRole("button", { name: "Agent reasoning level: Medium" }),
    ).toBeInTheDocument();

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    let picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "chief",
        model: "claude-opus-5",
        reasoningEffort: "medium",
      }),
    );
    expect(
      within(settings).getByRole("button", { name: "Agent model: Claude Opus 5" }),
    ).toBeEnabled();

    await fireEvent.click(
      within(settings).getByRole("button", { name: "Agent model: Claude Opus 5" }),
    );
    picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Codex:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Sol" }));
    await fireEvent.click(
      within(settings).getByRole("button", { name: /^Agent reasoning level:/ }),
    );
    await fireEvent.click(screen.getByRole("option", { name: "Extra high" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenLastCalledWith({
        botId: "chief",
        reasoningEffort: "xhigh",
      }),
    );
  });

  it("keeps provider choices separate for each agent profile", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    let settings = screen.getByRole("complementary", { name: "Agent settings" });
    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    let picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));

    await fireEvent.click(screen.getByRole("button", { name: /^Sales Outbound/ }));
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    settings = screen.getByRole("complementary", { name: "Agent settings" });
    expect(within(settings).getByRole("button", { name: "Agent model: Luna" })).toBeEnabled();

    await fireEvent.click(within(settings).getByRole("button", { name: "Agent model: Luna" }));
    picker = within(settings).getByRole("dialog", { name: "Choose agent model" });
    await fireEvent.click(within(picker).getByRole("tab", { name: /^Claude:/ }));
    await fireEvent.click(within(picker).getByRole("option", { name: "Claude Opus 5, default" }));
    await waitFor(() =>
      expect(window.openbot.agent.updateBot).toHaveBeenCalledWith({
        botId: "sales-outbound",
        model: "claude-opus-5",
        reasoningEffort: "medium",
      }),
    );
  });

  it("shows provider availability during onboarding", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "ready",
      cliVersion: "0.144.1",
      auth: { kind: "unknown" },
      providers: [
        { id: "codex", state: "available", version: "0.144.1", message: null },
        {
          id: "claude",
          state: "not-installed",
          version: null,
          message: "Claude CLI was not found.",
        },
      ],
      capabilities: { chat: "ready", browser: "ready", computerUse: "ready" },
      message: null,
      fullAccess: true,
    });
    render(() => <App />);

    const trigger = await screen.findByRole("button", { name: "Onboarding model: Luna" });
    await fireEvent.click(trigger);
    const picker = screen.getByRole("dialog", { name: "Choose agent model" });
    expect(within(picker).getByRole("tab", { name: /^Codex: 0.144.1/ })).toBeEnabled();
    const claude = within(picker).getByRole("tab", {
      name: "Claude: Claude CLI was not found.",
    });
    expect(claude).toBeEnabled();

    await fireEvent.click(claude);
    expect(within(picker).getByText("Claude CLI was not found.")).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Claude Opus 5, default" })).toBeDisabled();
  });

  it("does not remount settings or discard an in-progress edit on bot list refresh", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    const name = screen.getByRole("textbox", { name: "Agent name" });
    await fireEvent.input(name, { target: { value: "Draft coordinator name" } });

    emitAgentEvent?.({
      type: "bots-changed",
      bots: BOTS.map((bot) =>
        bot.id === "chief" ? { ...bot, preview: "A new backend preview" } : bot,
      ),
    });

    expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue(
      "Draft coordinator name",
    );
  });
});
