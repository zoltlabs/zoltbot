// P8: the agent's browser on the phone. Pure, so the frame check and the touch mapping are
// testable; app/chat/browser.tsx draws the frames and sends the input.

/** One picture of the agent's browser, as the Mac sends it. Never stored. */
export interface ScreenFrame {
  threadId: string;
  /** Base64 JPEG. */
  data: string;
  /** The page's size in CSS pixels, which input is given in. */
  width: number;
  height: number;
  url: string;
}

/** What `browser.view` answers. */
export interface ScreenState {
  running: boolean;
  url: string | null;
  /** The owner holds the browser and the agent waits. */
  control: boolean;
}

/** How often an open screen renews its view; the Mac drops a silent viewer after 20 seconds. */
export const SCREEN_RENEW_MS = 5_000;
/** How often an open chat asks whether its agent's browser runs. */
export const SCREEN_CHECK_MS = 15_000;
/** Larger than any frame the Mac sends a phone; anything bigger is not drawn. */
const MAX_FRAME_DATA = 512 * 1024;

const size = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1e5;

/** A frame for this chat, or undefined for anything malformed or meant for another chat. */
export function readFrame(value: unknown, threadId: string): ScreenFrame | undefined {
  const frame = (value ?? {}) as Record<string, unknown>;
  if (frame.threadId !== threadId) return undefined;
  if (typeof frame.data !== "string" || !frame.data || frame.data.length > MAX_FRAME_DATA)
    return undefined;
  if (!/^[A-Za-z0-9+/]+=*$/.test(frame.data)) return undefined;
  if (!size(frame.width) || !size(frame.height)) return undefined;
  return {
    threadId,
    data: frame.data,
    width: Number(frame.width),
    height: Number(frame.height),
    url: typeof frame.url === "string" ? frame.url.slice(0, 2000) : "",
  };
}

export function readState(value: unknown): ScreenState {
  const state = (value ?? {}) as Record<string, unknown>;
  return {
    running: state.running === true,
    url: typeof state.url === "string" ? state.url : null,
    control: state.control === true,
  };
}

/** The address bar's text: the host and path, without the scheme. */
export function shortUrl(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export interface Box {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

/** Where a page of `page` size sits when fitted inside `box`, keeping its shape. */
export function fit(box: Box, page: Box) {
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const width = page.width * scale;
  const height = page.height * scale;
  return { scale, left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/** A touch on the fitted picture, in page pixels; undefined outside the page. */
export function toPage(touch: Point, box: Box, page: Box): Point | undefined {
  const at = fit(box, page);
  if (!at.scale) return undefined;
  const x = (touch.x - at.left) / at.scale;
  const y = (touch.y - at.top) / at.scale;
  if (x < 0 || y < 0 || x > page.width || y > page.height) return undefined;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Trackpad mode: the pointer moved by a drag, in page pixels, kept on the page. */
export function movePointer(pointer: Point, drag: Point, scale: number, page: Box): Point {
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(0, value)));
  // A drag moves the pointer by as much as the finger moved on the picture.
  const factor = scale > 0 ? 1 / scale : 1;
  return {
    x: clamp(pointer.x + drag.x * factor, page.width),
    y: clamp(pointer.y + drag.y * factor, page.height),
  };
}

export type ScreenInput =
  | { kind: "mouse"; type: "move" | "down" | "up"; x: number; y: number; button?: "left" }
  | { kind: "mouse"; type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; type: "down" | "up" | "text"; key: string };

/** A click at one point: move there, press and release. */
export const click = (at: Point): ScreenInput[] => [
  { kind: "mouse", type: "move", ...at },
  { kind: "mouse", type: "down", ...at, button: "left" },
  { kind: "mouse", type: "up", ...at, button: "left" },
];

/** A drag on the picture scrolls the page the way the finger moved, like a touch screen. */
export function scroll(at: Point, drag: Point, scale: number): ScreenInput {
  const factor = scale > 0 ? 1 / scale : 1;
  const delta = (value: number) => Math.max(-1e4, Math.min(1e4, Math.round(-value * factor))) || 0;
  return { kind: "mouse", type: "wheel", ...at, deltaX: delta(drag.x), deltaY: delta(drag.y) };
}

/** Text from the phone's keyboard, in pieces the Mac accepts. */
export function typeText(text: string): ScreenInput[] {
  const pieces: ScreenInput[] = [];
  const chars = Array.from(text);
  // 16 characters stay within the Mac's 32 even when each takes two UTF-16 units.
  for (let i = 0; i < chars.length; i += 16)
    pieces.push({ kind: "key", type: "text", key: chars.slice(i, i + 16).join("") });
  return pieces;
}

/** One press of a named key, such as Enter or Backspace. */
export const press = (key: "Enter" | "Backspace"): ScreenInput[] => [
  { kind: "key", type: "down", key },
  { kind: "key", type: "up", key },
];

/** The message for a failed call, in the screen's words. */
export function screenError(error: unknown, taking: boolean) {
  const message = error instanceof Error ? error.message : "";
  if (/browser_not_running/.test(message)) return "The browser closed.";
  return taking ? "Couldn’t take over. Try again." : "Couldn’t hand back. Try again.";
}
