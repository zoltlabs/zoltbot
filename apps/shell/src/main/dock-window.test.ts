import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DOCK_CHANNELS, type DockState, dockBounds } from "../shared/dock";
import type { BotSummary } from "../shared/ipc";

vi.mock("electron", () => ({ BrowserWindow: class {}, screen: {} }));
const { DockController, dockHandlers } = await import("./dock-window");

const bot = (id: string, name = id) =>
  ({ id, name, avatarShape: "blob", avatarColor: "cyan" }) as BotSummary;

function fakeWindow() {
  const contents = new EventEmitter();
  const window = Object.assign(new EventEmitter(), {
    bounds: undefined as unknown,
    visible: false,
    destroyed: false,
    webContents: contents,
    isDestroyed: () => window.destroyed,
    isVisible: () => window.visible,
    setBounds: (bounds: unknown) => {
      window.bounds = bounds;
    },
    showInactive: () => {
      window.visible = true;
    },
    hide: () => {
      window.visible = false;
    },
    destroy: () => {
      window.destroyed = true;
    },
  });
  return window;
}

function setup(tasks = 0) {
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const sent: DockState[] = [];
  const displays = { listeners: 0 };
  const dock = new DockController({
    createWindow: () => {
      const window = fakeWindow();
      windows.push(window);
      return window as never;
    },
    workArea: () => ({ x: 0, y: 25, width: 1440, height: 875 }),
    onDisplaysChanged: () => {
      displays.listeners++;
      return () => displays.listeners--;
    },
    bots: () => [bot("a", "Research"), bot("b", "Release notes")],
    tasksNeedingYou: () => tasks,
    send: (_window, state) => sent.push(state),
  });
  return { dock, windows, sent, displays };
}

const ON = { agentDock: true, agentDockPosition: "right", textSize: "default" } as const;

describe("DockController", () => {
  it("makes no window while the dock is off", () => {
    const { dock, windows } = setup();
    dock.handle({ type: "turn-started", botId: "a", threadId: "t", turnId: "1" });
    expect(windows).toHaveLength(0);
    dock.apply({ ...ON, agentDock: false });
    expect(windows).toHaveLength(0);
  });

  it("shows working agents at the right edge and hides when nothing is going on", () => {
    const { dock, windows, sent } = setup();
    dock.apply(ON);
    // Nothing working: no window yet.
    expect(windows).toHaveLength(0);
    dock.handle({ type: "turn-started", botId: "a", threadId: "t", turnId: "1" });
    const window = windows[0];
    expect(window?.visible).toBe(true);
    expect(sent.at(-1)?.agents.map((agent) => [agent.name, agent.working])).toEqual([
      ["Research", true],
    ]);
    const state = sent.at(-1) as DockState;
    expect(window?.bounds).toEqual(dockBounds(state, { x: 0, y: 25, width: 1440, height: 875 }));
    dock.handle({
      type: "turn-completed",
      botId: "a",
      threadId: "t",
      turnId: "1",
      status: "completed",
    });
    expect(window?.visible).toBe(false);
  });

  it("counts questions and tasks as Needs you", () => {
    const { dock, sent } = setup(2);
    dock.apply(ON);
    expect(sent.at(-1)?.needsYou).toBe(2);
    dock.handle({
      type: "prompt",
      requestId: 1,
      botId: "b",
      threadId: "t",
      turnId: "1",
      questions: [],
    });
    expect(sent.at(-1)?.needsYou).toBe(3);
    expect(sent.at(-1)?.agents[0]).toMatchObject({ name: "Release notes", waiting: true });
    dock.handle({ type: "prompt-cleared", botId: "b" });
    expect(sent.at(-1)?.needsYou).toBe(2);
  });

  it("keeps an open mini chat after its turn ends and moves with the setting", () => {
    const { dock, windows, sent } = setup();
    dock.apply(ON);
    dock.handle({ type: "turn-started", botId: "a", threadId: "t", turnId: "1" });
    dock.expand("a");
    dock.handle({
      type: "turn-completed",
      botId: "a",
      threadId: "t",
      turnId: "1",
      status: "completed",
    });
    expect(sent.at(-1)).toMatchObject({ expanded: "a", agents: [{ id: "a", working: false }] });
    expect(windows[0]?.visible).toBe(true);
    dock.apply({ ...ON, agentDockPosition: "top" });
    expect(sent.at(-1)?.position).toBe("top");
    expect((windows[0]?.bounds as { y: number }).y).toBe(33);
  });

  it("forgets turns and questions when the daemon restarts or an agent goes", () => {
    const { dock, windows } = setup();
    dock.apply(ON);
    dock.handle({ type: "turn-started", botId: "a", threadId: "t", turnId: "1" });
    dock.handle({ type: "prompt", requestId: 1, botId: "gone", threadId: "t", turnId: "1", questions: [] });
    dock.handle({ type: "bots-changed", bots: [bot("a", "Research")] });
    expect(dock.state().needsYou).toBe(0);
    dock.handle({ type: "status", status: { phase: "restarting" } as never });
    expect(dock.state().agents).toEqual([]);
    expect(windows[0]?.visible).toBe(false);
  });

  it("grows with the text size, which zooms its page too", () => {
    const { dock, windows } = setup();
    dock.apply({ ...ON, textSize: "larger" });
    dock.handle({ type: "turn-started", botId: "a", threadId: "t", turnId: "1" });
    expect((windows[0]?.bounds as { width: number }).width).toBe(75);
  });

  it("stays closed once closed, even if events keep coming", () => {
    const { dock, windows } = setup();
    dock.apply(ON);
    dock.close();
    dock.handle({ type: "turn-started", botId: "a", threadId: "t", turnId: "1" });
    expect(windows).toHaveLength(0);
  });

  it("closes its window and stops following displays when turned off", () => {
    const { dock, windows, displays } = setup();
    dock.apply(ON);
    dock.handle({ type: "turn-started", botId: "a", threadId: "t", turnId: "1" });
    expect(displays.listeners).toBe(1);
    dock.apply({ ...ON, agentDock: false });
    expect(windows[0]?.destroyed).toBe(true);
    expect(displays.listeners).toBe(0);
    expect(dock.current).toBeNull();
  });

  it("opens the full chat and closes the mini chat", () => {
    const { dock } = setup();
    const opened: string[] = [];
    const handlers = dockHandlers(dock, (id) => opened.push(id));
    dock.apply(ON);
    handlers[DOCK_CHANNELS.expand]?.("a");
    expect(dock.state().expanded).toBe("a");
    handlers[DOCK_CHANNELS.openChat]?.("a");
    expect(opened).toEqual(["a"]);
    expect(dock.state().expanded).toBeNull();
    expect(() => handlers[DOCK_CHANNELS.openChat]?.(42)).toThrow("invalid_bot_id");
  });
});

describe("dockBounds", () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const state = (patch: Partial<DockState>): DockState => ({
    position: "right",
    agents: [],
    needsYou: 1,
    expanded: null,
    ...patch,
  });
  it("sits at the chosen edge, centered", () => {
    expect(dockBounds(state({}), area)).toEqual({ x: 1372, y: 433, width: 60, height: 60 });
    expect(dockBounds(state({ position: "left" }), area).x).toBe(8);
    expect(dockBounds(state({ position: "top" }), area)).toEqual({
      x: 690,
      y: 33,
      width: 60,
      height: 60,
    });
  });
  it("grows for the mini chat without leaving the screen", () => {
    const open = dockBounds(state({ expanded: "a" }), area);
    expect(open.width).toBe(380);
    expect(open.x + open.width).toBe(1432);
    expect(dockBounds(state({ expanded: "a" }), { ...area, height: 200 }).height).toBe(200);
  });
});
