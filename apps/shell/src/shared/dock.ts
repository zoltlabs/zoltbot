// D4: the agent dock, a small always-on-top bar showing working agents and the Needs you count.
import type { BotAvatarColor, BotAvatarShape, BotSummary } from "./ipc";

export const DOCK_CHANNELS = {
  getState: "dock:get-state",
  state: "dock:state",
  expand: "dock:expand",
  openChat: "dock:open-chat",
  /** Main to the main window: show this chat. */
  showChat: "dock:show-chat",
} as const;

export type DockPosition = "right" | "left" | "top";
export const DOCK_POSITIONS: readonly DockPosition[] = ["right", "left", "top"];

export interface DockAgent {
  id: string;
  name: string;
  avatarShape: BotAvatarShape;
  avatarColor: BotAvatarColor;
  /** A turn is running. */
  working: boolean;
  /** The agent asked the owner something. */
  waiting: boolean;
}

export interface DockState {
  position: DockPosition;
  agents: DockAgent[];
  needsYou: number;
  /** The agent whose mini chat is open. */
  expanded: string | null;
}

export interface DockDesktopApi {
  getState: () => Promise<DockState>;
  onState: (listener: (state: DockState) => void) => () => void;
  /** Opens one agent's mini chat, or closes it with null. */
  expand: (botId: string | null) => Promise<void>;
  /** Opens the agent's full chat in the main window. */
  openChat: (botId: string) => Promise<void>;
  /** In the main window: main asks it to show a chat. */
  onShowChat: (listener: (botId: string) => void) => () => void;
}

/** The agents the dock shows: those working or waiting on the owner, in the sidebar's order. */
export function dockAgents(
  bots: readonly BotSummary[],
  working: ReadonlySet<string>,
  waiting: ReadonlySet<string>,
): DockAgent[] {
  return bots
    .filter((bot) => working.has(bot.id) || waiting.has(bot.id))
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      avatarShape: bot.avatarShape,
      avatarColor: bot.avatarColor,
      working: working.has(bot.id),
      waiting: waiting.has(bot.id),
    }));
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Room for one avatar, the Needs you count and the bar's padding, in pixels. */
const SLOT = 44;
const PAD = 8;
const GAP = 8;
/** The mini chat's size. */
export const MINI_CHAT = { width: 320, height: 360 } as const;

/**
 * The dock window's size and place inside the display's work area. `scale` is the text size's
 * zoom, which the dock's page shares with the main window.
 */
export function dockBounds(state: DockState, workArea: Rect, scale = 1): Rect {
  const slots = state.agents.length + (state.needsYou > 0 ? 1 : 0);
  const length = Math.max(1, slots) * SLOT + PAD * 2;
  const vertical = state.position !== "top";
  const bar = vertical
    ? { width: SLOT + PAD * 2, height: length }
    : { width: length, height: SLOT + PAD * 2 };
  const size = state.expanded
    ? vertical
      ? { width: bar.width + MINI_CHAT.width, height: Math.max(bar.height, MINI_CHAT.height) }
      : { width: Math.max(bar.width, MINI_CHAT.width), height: bar.height + MINI_CHAT.height }
    : bar;
  const width = Math.min(Math.round(size.width * scale), workArea.width);
  const height = Math.min(Math.round(size.height * scale), workArea.height);
  const middleY = workArea.y + Math.round((workArea.height - height) / 2);
  const middleX = workArea.x + Math.round((workArea.width - width) / 2);
  if (state.position === "left") return { x: workArea.x + GAP, y: middleY, width, height };
  if (state.position === "top") return { x: middleX, y: workArea.y + GAP, width, height };
  return { x: workArea.x + workArea.width - width - GAP, y: middleY, width, height };
}
