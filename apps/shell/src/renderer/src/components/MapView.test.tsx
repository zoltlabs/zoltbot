import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { vi } from "vitest";
import type { ViewHostEvent, ViewSummary } from "../../../shared/ipc";
import { MapView } from "./MapView";
import { matchesShortcut, shortcutFor } from "./ViewGrants";

const MAP: ViewSummary = {
  id: "command-map",
  name: "Command map",
  enabled: true,
  canRead: true,
  requested: ["read", "act", "approve"],
  granted: ["read"],
  pending: ["act", "approve"],
  shortcuts: [{ id: "next-alert", keys: "Space", label: "Go to the latest alert" }],
  error: null,
};

function stubViews(map: ViewSummary) {
  let current = map;
  const listeners = new Set<(event: ViewHostEvent) => void>();
  const views = {
    getMap: vi.fn(async () => current),
    setGrants: vi.fn(async (_id: string, permissions: ViewSummary["granted"]) => {
      current = { ...current, granted: permissions, canRead: permissions.includes("read") };
      current.pending = current.canRead ? [] : ["read"];
    }),
    turnOn: vi.fn(async () => undefined),
    prepare: vi.fn(async () => ({ url: `zoltbot-view://${"a".repeat(64)}/index.html` })),
    connect: vi.fn(async () => ({ sessionId: "session-1" })),
    post: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
    shortcut: vi.fn(),
    onEvent: (listener: (event: ViewHostEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  Object.defineProperty(window, "openbot", { configurable: true, value: { views } });
  return views;
}

function renderMap() {
  return render(() => (
    <MapView
      sidebarCollapsed={false}
      onShowSidebar={() => undefined}
      onToggleSidebar={() => undefined}
      onOpenChat={() => undefined}
    />
  ));
}

afterEach(() => vi.unstubAllGlobals());

describe("map permissions", () => {
  it("asks for read before loading and saves the permissions left checked", async () => {
    const views = stubViews({ ...MAP, canRead: false, granted: [], pending: MAP.requested });
    renderMap();
    const card = await screen.findByRole("region", { name: "Allow Command map to" });
    expect(card).toBeInTheDocument();
    expect(views.prepare).not.toHaveBeenCalled();
    const read = screen.getByRole("checkbox", {
      name: "See your chats, projects, requests and spending",
    });
    expect(read).toBeChecked();
    expect(read).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    expect(
      screen.getByText("Agents act on these messages as if you wrote them."),
    ).toBeInTheDocument();

    await fireEvent.click(
      screen.getByRole("checkbox", { name: /Send messages to your agents and stop them/ }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Allow selected" }));
    expect(views.setGrants).toHaveBeenCalledWith("command-map", ["read", "approve"]);
    await waitFor(() => expect(views.prepare).toHaveBeenCalledWith("command-map"));
  });

  it("asks over the running map for new permissions and can be put off", async () => {
    const views = stubViews(MAP);
    renderMap();
    expect(await screen.findByTitle("Command map")).toHaveAttribute("sandbox", "allow-scripts");
    expect(screen.queryByRole("checkbox", { name: /See your chats/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow all" })).toBeEnabled();
    await fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(views.setGrants).toHaveBeenCalledWith("command-map", ["read"]);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Allow Command map to" })).toBeNull(),
    );
  });

  it("allows everything the card lists", async () => {
    const views = stubViews(MAP);
    renderMap();
    await fireEvent.click(await screen.findByRole("button", { name: "Allow all" }));
    expect(views.setGrants).toHaveBeenCalledWith("command-map", ["read", "act", "approve"]);
  });

  it("shows the granted set in the header and revokes or grants one at a time", async () => {
    const views = stubViews({ ...MAP, pending: [] });
    renderMap();
    const button = await screen.findByRole("button", { name: "Permissions" });
    await fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const read = screen.getByRole("switch", {
      name: "See your chats, projects, requests and spending",
    });
    const act = screen.getByRole("switch", { name: "Send messages to your agents and stop them" });
    expect(read).toHaveAttribute("aria-checked", "true");
    expect(act).toHaveAttribute("aria-checked", "false");
    act.focus();
    await fireEvent.click(act);
    expect(views.setGrants).toHaveBeenLastCalledWith("command-map", ["read", "act"]);
    // A second change waits for the first to save.
    await fireEvent.click(read);
    expect(views.setGrants).toHaveBeenCalledOnce();
    await waitFor(() => expect(act).toHaveAttribute("aria-checked", "true"));
    await fireEvent.click(read);
    expect(views.setGrants).toHaveBeenLastCalledWith("command-map", ["act"]);
    expect(act).toHaveFocus();

    await fireEvent.keyDown(act, { key: "Escape" });
    expect(screen.queryByRole("switch")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("says when the permissions couldn't be saved", async () => {
    const views = stubViews(MAP);
    views.setGrants.mockRejectedValueOnce(new Error("daemon offline"));
    renderMap();
    await fireEvent.click(await screen.findByRole("button", { name: "Allow all" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Zoltbot couldn't save these permissions. Try again.",
    );
  });
});

describe("view shortcuts", () => {
  const key = (init: Partial<KeyboardEvent>) => ({
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  });

  it("matches declared keys with their modifiers", () => {
    expect(matchesShortcut("Space", key({ key: " ", code: "Space" }))).toBe(true);
    expect(matchesShortcut("Space", key({ key: " ", code: "Space", shiftKey: true }))).toBe(false);
    expect(matchesShortcut("mod+k", key({ key: "k", metaKey: true }), true)).toBe(true);
    expect(matchesShortcut("mod+k", key({ key: "k", ctrlKey: true }), false)).toBe(true);
    expect(matchesShortcut("mod+k", key({ key: "k", ctrlKey: true }), true)).toBe(false);
    expect(matchesShortcut("shift", key({ key: "Shift", shiftKey: true }))).toBe(false);
  });

  it("forwards Space to the running map when focus is in the shell", async () => {
    const views = stubViews({ ...MAP, pending: [] });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    renderMap();
    const frame = (await screen.findByTitle("Command map")) as HTMLIFrameElement;
    vi.spyOn(frame.contentWindow as Window, "postMessage").mockImplementation(() => undefined);
    await fireEvent.load(frame);
    await waitFor(() => expect(views.update).toHaveBeenCalled());
    await fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(views.shortcut).toHaveBeenCalledWith("session-1", "next-alert");
    await fireEvent.keyDown(screen.getByRole("button", { name: "Permissions" }), {
      key: " ",
      code: "Space",
    });
    expect(views.shortcut).toHaveBeenCalledOnce();
  });

  it("leaves keys alone when focus is on a control", () => {
    const shortcuts = MAP.shortcuts;
    const press = (target: EventTarget) => {
      const event = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true });
      Object.defineProperty(event, "target", { value: target });
      return shortcutFor(shortcuts, event);
    };
    expect(press(document.body)?.id).toBe("next-alert");
    expect(press(document.createElement("button"))).toBeUndefined();
    expect(press(document.createElement("textarea"))).toBeUndefined();
  });
});
