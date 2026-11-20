import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { emitAgentEvent, setUpAppTest } from "./app-test-harness";

describe("Zoltbot connected desktop shell", () => {
  beforeEach(setUpAppTest);

  it("fully hides and restores the left sidebar without losing its width", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    const frame = screen.getByRole("main", { name: "Conversation" }).closest(".app-frame");
    const sidebarToggle = screen.getByRole("button", { name: "Hide sidebar" });
    expect(sidebarToggle).toHaveClass("sidebar-icon-button");
    expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");
    await fireEvent.click(sidebarToggle);

    expect(screen.queryByRole("complementary", { name: "Bot navigation" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("separator", { name: "Resize left sidebar" }),
    ).not.toBeInTheDocument();
    expect(frame).toHaveClass("app-frame-sidebar-collapsed");
    expect(frame).toHaveStyle("--left-panel-width: 0px");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("true");
    const restoreSidebar = screen.getByRole("button", { name: "Show sidebar" });
    expect(restoreSidebar).toHaveClass("sidebar-icon-button");
    expect(restoreSidebar).toHaveAttribute("aria-expanded", "false");

    await fireEvent.click(restoreSidebar);

    expect(screen.getByRole("complementary", { name: "Bot navigation" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize left sidebar" })).toHaveAttribute(
      "aria-valuenow",
      "275",
    );
    expect(frame).not.toHaveClass("app-frame-sidebar-collapsed");
    expect(window.localStorage.getItem("openbot:left-panel-collapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("shows a stable indicator while an agent controls the embedded browser", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-1",
          title: "Local smoke page",
          url: "http://127.0.0.1:4321",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
        {
          id: "tab-2",
          title: "Second page",
          url: "https://example.com/second",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
        {
          id: "tab-3",
          title: "Third page",
          url: "https://example.com/third",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-1",
    });
    emitAgentEvent?.({
      type: "browser-control-changed",
      state: {
        sessions: [
          {
            id: "thread-chief:turn-1",
            threadId: "thread-chief",
            turnId: "turn-1",
            callId: "call-1",
            tabId: null,
            action: "type",
            phase: "acting",
            startedAt: "2026-08-12T10:00:00.000Z",
          },
        ],
      },
    });

    const controlledTab = await screen.findByRole("tab", {
      name: "Local smoke page, controlled by Chief",
    });
    expect(controlledTab.closest(".browser-tab-wrap")).toHaveClass("browser-tab-controlled");
    expect(screen.getByRole("complementary", { name: "Browser" })).toHaveClass(
      "browser-panel-controlled",
    );
    const browserTabStrip = document.querySelector(".browser-tab-strip");
    expect(browserTabStrip?.querySelectorAll(".browser-tab-wrap")).toHaveLength(3);
    expect(browserTabStrip?.lastElementChild).toBe(
      screen.getByRole("button", { name: "New browser tab" }),
    );
    expect(screen.queryByRole("button", { name: "Hide browser panel" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "New browser tab" }));
    expect(window.openbot.browser.open).toHaveBeenCalledWith({
      url: "https://www.google.com",
      ownerThreadId: "thread-chief",
      ownerBotId: "chief",
    });
    expect(screen.queryByText("Typing…")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Chief is controlling the browser" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Chief is controlling the browser" })).toHaveClass(
      "header-panel-toggle",
    );

    emitAgentEvent?.({
      type: "browser-control-changed",
      state: {
        sessions: [
          {
            id: "thread-chief:turn-1",
            threadId: "thread-chief",
            turnId: "turn-1",
            callId: "call-1",
            tabId: "tab-1",
            action: "type",
            phase: "waiting",
            startedAt: "2026-08-12T10:00:00.000Z",
          },
        ],
      },
    });
    expect(screen.getByRole("tab", { name: "Local smoke page, controlled by Chief" })).toBe(
      controlledTab,
    );

    emitAgentEvent?.({ type: "browser-control-changed", state: { sessions: [] } });
    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "Local smoke page, controlled by Chief" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "Local smoke page" })).toBe(controlledTab);
    expect(controlledTab.closest(".browser-tab-wrap")).not.toHaveClass("browser-tab-controlled");
    expect(screen.getByRole("complementary", { name: "Browser" })).not.toHaveClass(
      "browser-panel-controlled",
    );
  });

  it("updates embedded browser bounds when the window moves browser surface", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });
    emitAgentEvent?.({
      type: "browser-changed",
      tabs: [
        {
          id: "tab-resize",
          title: "Resize test",
          url: "https://example.com",
          loading: false,
          ownerThreadId: "thread-chief",
          ownerBotId: "chief",
        },
      ],
      activeTabId: "tab-resize",
    });
    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    const surface = document.querySelector(".browser-surface");
    if (!(surface instanceof HTMLElement)) throw new Error("Browser surface was not rendered.");
    await waitFor(() =>
      expect(window.openbot.browser.setVisible).toHaveBeenCalledWith(
        expect.objectContaining({ visible: true }),
      ),
    );
    vi.mocked(window.openbot.browser.setVisible).mockClear();
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
      x: 640,
      y: 73,
      width: 380,
      height: 600,
      top: 73,
      right: 1020,
      bottom: 673,
      left: 640,
      toJSON: () => ({}),
    });

    window.dispatchEvent(new Event("resize"));

    await waitFor(() =>
      expect(window.openbot.browser.setVisible).toHaveBeenLastCalledWith({
        visible: true,
        bounds: { x: 640, y: 73, width: 380, height: 600 },
      }),
    );
  });

  it("closes settings on agent switch but restores browser panels", async () => {
    render(() => <App />);
    await screen.findByRole("heading", { name: "Chief" });

    await fireEvent.click(screen.getByRole("button", { name: "View agent settings" }));
    expect(screen.getByRole("complementary", { name: "Agent settings" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open computer" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: "Open computer" }));
    expect(screen.getByRole("complementary", { name: "Browser" })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Chief/ }));
    expect(screen.queryByRole("complementary", { name: "Agent settings" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Browser" })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: /Sales Outbound/ }));
    expect(screen.getByRole("complementary", { name: "Browser" })).toBeInTheDocument();
  });
});
