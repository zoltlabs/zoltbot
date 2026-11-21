// D4: the agent dock window. Main keeps the dock's state from agent events, so the dock is right
// even when it opens in the middle of a turn.
import { BrowserWindow, type Rectangle, screen } from "electron";
import {
  DOCK_CHANNELS,
  type DockPosition,
  type DockState,
  dockAgents,
  dockBounds,
} from "../shared/dock";
import type { AgentEvent, BotSummary } from "../shared/ipc";
import { type Preferences, TEXT_SCALE } from "../shared/preferences";
import type { TaskSummary } from "../shared/tasks";

export interface DockDeps {
  /** Makes the frameless, always-on-top window and loads the dock page into it. */
  createWindow: () => BrowserWindow;
  workArea: () => Rectangle;
  /** Calls back when displays are added, removed or resized. Returns a cleanup. */
  onDisplaysChanged: (listener: () => void) => () => void;
  bots: () => BotSummary[];
  /** Tasks waiting on the owner: results to review and failures. */
  tasksNeedingYou: () => number;
  /** Sends the dock's state to its page. */
  send: (window: BrowserWindow, state: DockState) => void;
}

export type DockSettings = Pick<Preferences, "agentDock" | "agentDockPosition" | "textSize">;

export class DockController {
  private window: BrowserWindow | null = null;
  private enabled = false;
  private scale = 1;
  private position: DockPosition = "right";
  private expanded: string | null = null;
  private readonly working = new Set<string>();
  private readonly waiting = new Set<string>();
  private stopDisplays: (() => void) | undefined;

  constructor(private readonly deps: DockDeps) {}

  /** The dock window, if it exists. */
  get current(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  state(): DockState {
    const agents = dockAgents(this.deps.bots(), this.working, this.waiting);
    if (this.expanded && !agents.some((agent) => agent.id === this.expanded)) {
      // Keep an open mini chat after its turn ends, so the owner can read the reply.
      const bot = this.deps.bots().find((candidate) => candidate.id === this.expanded);
      if (bot)
        agents.push({
          id: bot.id,
          name: bot.name,
          avatarShape: bot.avatarShape,
          avatarColor: bot.avatarColor,
          working: false,
          waiting: false,
        });
      else this.expanded = null;
    }
    return {
      position: this.position,
      agents,
      needsYou: this.waiting.size + this.deps.tasksNeedingYou(),
      expanded: this.expanded,
    };
  }

  apply(settings: DockSettings): void {
    const scale = TEXT_SCALE[settings.textSize] ?? 1;
    const moved = settings.agentDockPosition !== this.position || scale !== this.scale;
    this.scale = scale;
    this.enabled = settings.agentDock;
    this.position = settings.agentDockPosition;
    if (!this.enabled) {
      this.close();
      return;
    }
    this.stopDisplays ??= this.deps.onDisplaysChanged(() => this.refresh());
    if (moved || !this.current) this.refresh();
  }

  /** Follows turns and questions. Call with every agent event. */
  handle(event: AgentEvent): void {
    switch (event.type) {
      case "turn-started":
        this.working.add(event.botId);
        break;
      case "turn-completed":
        this.working.delete(event.botId);
        break;
      case "prompt":
        this.waiting.add(event.botId);
        break;
      case "prompt-cleared":
        this.waiting.delete(event.botId);
        break;
      case "bots-changed": {
        // A deleted agent neither works nor waits.
        const ids = new Set(event.bots.map((bot) => bot.id));
        for (const set of [this.working, this.waiting])
          for (const id of set) if (!ids.has(id)) set.delete(id);
        break;
      }
      case "status":
        // The daemon went away: its turns and questions went with it.
        if (event.status.phase === "restarting" || event.status.phase === "stopped") {
          this.working.clear();
          this.waiting.clear();
        }
        break;
      case "company-changed":
        break;
      default:
        return;
    }
    if (this.enabled) this.refresh();
  }

  /** Opens an agent's mini chat, or closes it with null. */
  expand(botId: string | null): void {
    this.expanded = botId;
    if (this.enabled) this.refresh();
  }

  /** Shows, moves or hides the dock to match its state. */
  refresh(): void {
    const state = this.state();
    const empty = state.agents.length === 0 && state.needsYou === 0;
    if (empty) {
      this.current?.hide();
      return;
    }
    const window = this.current ?? this.open();
    window.setBounds(dockBounds(state, this.deps.workArea(), this.scale));
    this.deps.send(window, state);
    if (!window.isVisible()) window.showInactive();
  }

  close(): void {
    // Events that arrive while the app quits must not open it again.
    this.enabled = false;
    this.stopDisplays?.();
    this.stopDisplays = undefined;
    this.expanded = null;
    const window = this.current;
    this.window = null;
    window?.destroy();
  }

  private open(): BrowserWindow {
    const window = this.deps.createWindow();
    window.on("closed", () => {
      if (this.window === window) this.window = null;
    });
    // The page asks for its state once it loads; send it again then.
    window.webContents.on("did-finish-load", () => this.deps.send(window, this.state()));
    this.window = window;
    return window;
  }
}

const DISPLAY_EVENTS = ["display-added", "display-removed", "display-metrics-changed"] as const;

/** The dock wired to Electron: its window, the primary display and display changes. */
export function electronDock(source: {
  preload: string;
  bots: () => BotSummary[];
  tasks: () => TaskSummary[];
}): DockController {
  return new DockController({
    createWindow: () => {
      const window = new BrowserWindow(dockWindowOptions(source.preload));
      window.setAlwaysOnTop(true, "floating");
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      const developmentUrl = process.env.ELECTRON_RENDERER_URL;
      void window.loadURL(
        developmentUrl
          ? new URL("dock.html", `${developmentUrl}/`).href
          : "openbot-app://app/dock.html",
      );
      return window;
    },
    workArea: () => screen.getPrimaryDisplay().workArea,
    onDisplaysChanged: (listener) => {
      for (const name of DISPLAY_EVENTS) screen.on(name as "display-added", listener);
      return () => {
        for (const name of DISPLAY_EVENTS) screen.off(name as "display-added", listener);
      };
    },
    bots: source.bots,
    tasksNeedingYou: () =>
      source.tasks().filter((task) => task.state === "review" || task.state === "failed").length,
    send: (window, state) => window.webContents.send(DOCK_CHANNELS.state, state),
  });
}

/** The dock's window: frameless, see-through, above other apps and on every desktop. */
export function dockWindowOptions(preload: string): Electron.BrowserWindowConstructorOptions {
  return {
    width: 60,
    height: 60,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // The first click on an avatar works while another app is in front.
    acceptFirstMouse: true,
    title: "Agent dock",
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };
}

/** The dock's IPC handlers, for main's trusted-sender wrapper. */
export function dockHandlers(
  dock: DockController,
  openChat: (botId: string) => void,
): Record<string, (input: unknown) => unknown> {
  const botId = (input: unknown): string => {
    if (typeof input !== "string" || !input) throw new Error("invalid_bot_id");
    return input;
  };
  return {
    [DOCK_CHANNELS.getState]: () => dock.state(),
    [DOCK_CHANNELS.expand]: (input) => dock.expand(input === null ? null : botId(input)),
    [DOCK_CHANNELS.openChat]: (input) => {
      const id = botId(input);
      dock.expand(null);
      openChat(id);
    },
  };
}
