import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAccountStatus } from "../../shared/ipc";
import { App } from "./App";
import {
  BOTS,
  confirmOnboardingModel,
  emitAgentEvent,
  emitUpdateStatus,
  READY_STATUS,
  SETUP_STATUS,
  setUpAppTest,
} from "./app-test-harness";

describe("Zoltbot connected desktop shell", () => {
  beforeEach(setUpAppTest);

  it("skips setup and remembers it when the daemon already has a working agent", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    render(() => <App />);

    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Set up a coding agent" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "codex" }),
    );
  });

  it("lists the daemon's agents and what to do when none works yet", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(SETUP_STATUS);
    vi.mocked(window.openbot.agent.refreshAgents).mockResolvedValueOnce(SETUP_STATUS);
    render(() => <App />);

    expect(
      await screen.findByRole("dialog", { name: "Set up a coding agent" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();
    const agents = screen.getByRole("radiogroup", { name: "Default agent" });
    const codex = within(agents).getByRole("radio", { name: /Codex.*Not installed/ });
    expect(codex).toHaveFocus();
    expect(screen.getByText("Codex isn’t installed.")).toBeInTheDocument();
    expect(screen.getByText("npm install -g example-codex")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "How to install Codex" }));
    expect(window.openbot.openUrl).toHaveBeenCalledWith("https://example.com/install-codex");

    await fireEvent.click(
      within(agents).getByRole("radio", { name: /Claude Code.*Sign in required/ }),
    );
    expect(screen.getByText("claude auth login")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(window.openbot.agent.refreshAgents).toHaveBeenCalledOnce();
    expect(window.openbot.saveSetup).not.toHaveBeenCalled();
  });

  it("finishes setup on its own once an agent starts working", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(SETUP_STATUS);
    render(() => <App />);

    await screen.findByRole("dialog", { name: "Set up a coding agent" });
    emitAgentEvent?.({
      type: "status",
      status: {
        ...SETUP_STATUS,
        providers: [
          ...(SETUP_STATUS.providers ?? []).slice(0, 1),
          { id: "claude", name: "Claude Code", state: "available", version: null, message: null },
        ],
      },
    });

    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
    await waitFor(() =>
      expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "claude" }),
    );
  });

  it("offers first jobs for connected apps before finishing setup (D5)", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(SETUP_STATUS);
    const addStarter = vi.fn(async () => {});
    window.openbot.routines = {
      ...window.openbot.routines,
      starters: vi.fn(async () => [
        { id: "weekly-inbox", name: "Weekly inbox summary" },
        { id: "morning-briefing", name: "Morning briefing" },
      ]),
      addStarter,
    };
    render(() => <App />);

    const agents = await screen.findByRole("radiogroup", { name: "Default agent" });
    await fireEvent.click(within(agents).getByRole("radio", { name: /Claude Code/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Continue with Claude Code" }));
    expect(
      await screen.findByRole("heading", { name: "Start with one of these" }),
    ).toBeInTheDocument();
    expect(window.openbot.saveSetup).not.toHaveBeenCalled();
    const [add] = screen.getAllByRole("button", { name: "Add" });
    await waitFor(() => expect(add).toHaveFocus());
    await fireEvent.click(add as HTMLElement);
    await waitFor(() =>
      expect(addStarter).toHaveBeenCalledWith({ id: "weekly-inbox", provider: "claude" }),
    );
    await waitFor(() => expect(screen.queryByText("Weekly inbox summary")).not.toBeInTheDocument());
    await fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "claude" }),
    );
    expect(addStarter).toHaveBeenCalledOnce();
  });

  it("lets the user continue with an agent that still needs setup", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(SETUP_STATUS);
    render(() => <App />);

    const agents = await screen.findByRole("radiogroup", { name: "Default agent" });
    await fireEvent.click(within(agents).getByRole("radio", { name: /Claude Code/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Continue with Claude Code" }));
    expect(window.openbot.saveSetup).toHaveBeenCalledWith({ preferredProvider: "claude" });
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
  });

  it("lets the user review agents and permissions from the account menu", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    await fireEvent.click(screen.getByRole("menuitem", { name: "Agents & permissions" }));

    expect(screen.getByRole("dialog", { name: "Agents & permissions" })).toBeInTheDocument();
    const agents = screen.getByRole("radiogroup", { name: "Default agent" });
    expect(within(agents).getByRole("radio", { name: /Codex.*Available/ })).toBeChecked();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await fireEvent.click(within(agents).getByRole("radio", { name: /Claude Code.*Available/ }));
    await fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(window.openbot.saveSetup).toHaveBeenLastCalledWith({ preferredProvider: "claude" });
    expect(screen.queryByRole("dialog", { name: "Agents & permissions" })).not.toBeInTheDocument();
  });

  it("lists only installed agents and makes the project after an agent is saved", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      ...READY_STATUS,
      providers: [
        ...(READY_STATUS.providers ?? []),
        { id: "goose", name: "Goose", state: "not-installed", version: null, message: null },
      ],
    });
    vi.mocked(window.openbot.agent.createProject)
      .mockRejectedValueOnce(new Error("Add an agent in Zoltbot first."))
      .mockResolvedValueOnce({ ...BOTS[0], id: "bot-ceo", name: "zoltbot CEO" });
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "Agents & permissions" });
    expect(screen.queryByRole("option", { name: "Create new agent" })).not.toBeInTheDocument();
    const agents = within(dialog).getByRole("radiogroup", { name: "Default agent" });
    expect(within(agents).queryByRole("radio", { name: /Goose/ })).not.toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(window.openbot.agent.createProject).toHaveBeenCalledTimes(2));
  });

  it("opens the create-agent picker for a new user with no agents", async () => {
    vi.mocked(window.openbot.agent.listBots).mockResolvedValueOnce([]);
    render(() => <App />);

    expect(await screen.findByRole("option", { name: "Create new agent" })).toBeInTheDocument();
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
  });

  it("keeps agents disabled when setup persistence fails", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(SETUP_STATUS);
    vi.mocked(window.openbot.saveSetup).mockRejectedValueOnce(new Error("Could not save setup."));
    render(() => <App />);

    expect(
      within(await screen.findByRole("radiogroup", { name: "Default agent" })).getByRole("radio", {
        name: /Codex/,
      }),
    ).toBeChecked();
    await fireEvent.click(screen.getByRole("button", { name: "Continue with Codex" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save setup.");
    expect(screen.queryByRole("heading", { name: "Chief" })).not.toBeInTheDocument();
  });

  it("requests optional macOS permissions and shows the new state", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(SETUP_STATUS);
    vi.mocked(window.openbot.getMacPermissions).mockResolvedValueOnce({
      screenRecording: "not-determined",
      accessibility: "not-determined",
    });
    vi.mocked(window.openbot.requestMacPermission).mockResolvedValueOnce({
      screenRecording: "granted",
      accessibility: "not-determined",
    });
    render(() => <App />);

    const row = (await screen.findByText("Screen Recording")).closest(".mac-permission-row");
    const action = row?.querySelector("button");
    expect(action).not.toBeNull();
    await fireEvent.click(action as HTMLButtonElement);
    expect(window.openbot.requestMacPermission).toHaveBeenCalledWith("screen-recording");
    expect(action).toHaveTextContent("Allowed");

    vi.mocked(window.openbot.getMacPermissions).mockResolvedValueOnce({
      screenRecording: "granted",
      accessibility: "granted",
    });
    window.dispatchEvent(new Event("focus"));
    const accessibilityRow = screen.getByText("Accessibility").closest(".mac-permission-row");
    await waitFor(() =>
      expect(accessibilityRow?.querySelector("button")).toHaveTextContent("Allowed"),
    );
  });

  it("hides macOS permissions on other platforms", async () => {
    vi.mocked(window.openbot.getSetupState).mockResolvedValueOnce({
      completed: false,
      preferredProvider: null,
    });
    vi.mocked(window.openbot.getAppInfo).mockResolvedValueOnce({
      name: "Zoltbot",
      version: "0.1.0",
      platform: "win32",
    });
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce(SETUP_STATUS);
    render(() => <App />);

    expect(
      await screen.findByRole("dialog", { name: "Set up a coding agent" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Mac permissions")).not.toBeInTheDocument());
    expect(window.openbot.getMacPermissions).not.toHaveBeenCalled();
  });

  it("uses the backend bot list and shows local onboarding for a real empty snapshot", async () => {
    render(() => <App />);
    expect(await screen.findByRole("heading", { name: "Chief" })).toBeInTheDocument();
    expect(await screen.findByText("Choose a model to get started.")).toBeInTheDocument();
    expect(
      screen.queryByRole("listbox", { name: "What do you want me helping with most?" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "false");
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    await confirmOnboardingModel();
    expect(
      screen.getByRole("listbox", { name: "What do you want me helping with most?" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "true");
    expect(screen.getByRole("button", { name: "Attach a file" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.queryByText(/Salesforce account queue/i)).not.toBeInTheDocument();
  });

  it("guides signed-out users before enabling chat", async () => {
    vi.mocked(window.openbot.agent.getStatus).mockResolvedValueOnce({
      phase: "blocked",
      cliVersion: "0.144.1",
      auth: { kind: "signed-out" },
      capabilities: { chat: "unavailable", browser: "ready", computerUse: "unavailable" },
      message: "Sign in to Codex.",
      fullAccess: true,
    });
    render(() => <App />);

    expect(await screen.findByText("Set up a coding agent")).toBeInTheDocument();
    expect(screen.getByText("Sign in to Codex.")).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: /helping with most/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message Chief")).toHaveAttribute("contenteditable", "false");
    await fireEvent.click(screen.getByRole("button", { name: "Set up" }));
    expect(screen.getByRole("dialog", { name: "Agents & permissions" })).toBeInTheDocument();
  });

  it("shows the Zoltbot account and signs out", async () => {
    render(() => <App />);
    const accountButton = await screen.findByRole("button", { name: "Open account menu" });
    await waitFor(() => expect(accountButton).toHaveTextContent("sam@example.com"));

    await fireEvent.click(accountButton);
    expect(screen.getByText("Sam")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(window.openbot.account.signOut).toHaveBeenCalledOnce();
    await waitFor(() => expect(accountButton).toHaveTextContent("Sign in"));
  });

  it("signs in through the browser and can cancel while waiting", async () => {
    vi.mocked(window.openbot.account.getStatus).mockResolvedValueOnce({
      configured: true,
      signedIn: false,
      email: null,
      name: null,
      managementUrl: null,
    });
    const finish: Array<(value: CloudAccountStatus) => void> = [];
    vi.mocked(window.openbot.account.signIn).mockImplementationOnce(
      () => new Promise<CloudAccountStatus>((resolve) => finish.push(resolve)),
    );
    render(() => <App />);
    const accountButton = await screen.findByRole("button", { name: "Open account menu" });
    await waitFor(() => expect(accountButton).toHaveTextContent("Sign in"));

    await fireEvent.click(accountButton);
    await fireEvent.click(screen.getByRole("menuitem", { name: "Sign in" }));
    expect(screen.getByRole("menuitem", { name: "Waiting for browser…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await fireEvent.click(screen.getByRole("menuitem", { name: "Cancel sign-in" }));
    expect(window.openbot.account.cancel).toHaveBeenCalledOnce();

    finish[0]?.({
      configured: true,
      signedIn: true,
      email: "sam@example.com",
      name: "Sam",
      managementUrl: null,
    });
    await waitFor(() => expect(accountButton).toHaveTextContent("sam@example.com"));
  });

  it("hides sign-in when this build has no hosted account service", async () => {
    vi.mocked(window.openbot.account.getStatus).mockResolvedValueOnce({
      configured: false,
      signedIn: false,
      email: null,
      name: null,
      managementUrl: null,
    });
    render(() => <App />);
    const accountButton = await screen.findByRole("button", { name: "Open account menu" });
    await waitFor(() => expect(window.openbot.account.getStatus).toHaveBeenCalled());
    expect(accountButton).toHaveTextContent("Zoltbot");
    await fireEvent.click(accountButton);
    expect(screen.queryByRole("menuitem", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("shows a compact account menu with weekly usage and contact actions", async () => {
    render(() => <App />);
    const accountButton = await screen.findByRole("button", { name: "Open account menu" });

    fireEvent.click(accountButton);
    await waitFor(() => expect(window.openbot.agent.getUsage).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Weekly usage")).toBeInTheDocument();
    expect(screen.getByText("59%")).toBeInTheDocument();
    expect(screen.queryByText(/ChatGPT Pro/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Developer preview/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lifetime/i)).not.toBeInTheDocument();

    expect(screen.queryByRole("menuitem", { name: "Export data" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Export diagnostics" })).not.toBeInTheDocument();

    await screen.findByRole("menuitem", { name: "Send feedback" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Send feedback" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("feedback"));

    fireEvent.click(accountButton);
    fireEvent.click(screen.getByRole("menuitem", { name: "Message" }));
    await waitFor(() => expect(window.openbot.openExternal).toHaveBeenCalledWith("message"));
  });

  it("shows an available update, downloads it, and exposes restart to install", async () => {
    vi.mocked(window.openbot.update.getStatus).mockResolvedValueOnce({
      phase: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: null,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: null,
    });
    render(() => <App />);

    expect(await screen.findByText("Update")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open account menu" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Download update/ }));
    await waitFor(() => expect(window.openbot.update.download).toHaveBeenCalledOnce());

    emitUpdateStatus?.({
      phase: "ready",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progress: 100,
      checkedAt: "2026-08-12T22:00:00.000Z",
      message: null,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Restart to update/ }));
    await waitFor(() => expect(window.openbot.update.install).toHaveBeenCalledOnce());
  });
});
