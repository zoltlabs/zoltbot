// B3: the owner's mouse and keys on the Browser panel's canvas, mapped to the agent's page.

export type AgentBrowserInput =
  | {
      kind: "mouse";
      type: "move" | "down" | "up" | "wheel";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      deltaX?: number;
      deltaY?: number;
    }
  | { kind: "key"; type: "down" | "up"; key: string };

/**
 * Converts a point on the canvas (CSS pixels from its top-left, at its displayed size) to page
 * pixels. The canvas shows the whole page scaled, so both axes scale by the same ratio.
 */
export function canvasToPage(
  point: { x: number; y: number },
  shown: { width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | undefined {
  if (shown.width <= 0 || shown.height <= 0 || page.width <= 0 || page.height <= 0)
    return undefined;
  const x = (point.x / shown.width) * page.width;
  const y = (point.y / shown.height) * page.height;
  if (x < 0 || y < 0 || x > page.width || y > page.height) return undefined;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

const BUTTONS = ["left", "middle", "right"] as const;
export const mouseButton = (button: number) => BUTTONS[button] ?? "left";

/** Keys the page gets as presses. Shortcuts that belong to the app (⌘W, ⌘Q, ⌘Tab) never go. */
export function pageKey(event: { key: string; metaKey: boolean }): string | undefined {
  if (event.metaKey && ["w", "q", "Tab", "h", "m", ","].includes(event.key)) return undefined;
  if (event.key === "Unidentified" || event.key === "Dead" || event.key === "Process")
    return undefined;
  return event.key.length > 32 ? undefined : event.key;
}
