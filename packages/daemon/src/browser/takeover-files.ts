// B3: files the daemon and the agent's launcher share while the owner controls the browser.
import path from "node:path";
import type { BrowserBinding } from "./runtime.js";

/** Exists while the owner controls the browser; the launcher waits for it to go. */
export const controlFile = (b: Pick<BrowserBinding, "home">) => path.join(b.home, "control.json");
/** Notes for the agent, printed after its next browser command and then removed. */
export const notesFile = (b: Pick<BrowserBinding, "home">) => path.join(b.home, "notes.jsonl");

/** The owner's mouse or key on the Browser panel, in page CSS pixels. */
export type BrowserInput =
  | {
      kind: "mouse";
      type: "move" | "down" | "up" | "wheel";
      x: number;
      y: number;
      button?: "left" | "right" | "middle";
      deltaX?: number;
      deltaY?: number;
    }
  /** `text` types a string as it is (the phone's keyboard); `down`/`up` press one key. */
  | { kind: "key"; type: "down" | "up" | "text"; key: string };

const coordinate = (value: unknown, limit: number) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

/** Accepts only well-formed input. Errors never include what was typed. */
export function parseInput(value: unknown): BrowserInput {
  const event = (value ?? {}) as Record<string, unknown>;
  if (event.kind === "mouse") {
    if (!["move", "down", "up", "wheel"].includes(String(event.type)))
      throw Error("browser_input_invalid");
    if (
      !coordinate(event.x, 1e5) ||
      !coordinate(event.y, 1e5) ||
      Number(event.x) < 0 ||
      Number(event.y) < 0
    )
      throw Error("browser_input_invalid");
    if (event.button !== undefined && !["left", "right", "middle"].includes(String(event.button)))
      throw Error("browser_input_invalid");
    for (const delta of [event.deltaX, event.deltaY])
      if (delta !== undefined && !coordinate(delta, 1e4)) throw Error("browser_input_invalid");
    return {
      kind: "mouse",
      type: event.type as "move",
      x: Number(event.x),
      y: Number(event.y),
      ...(event.button ? { button: event.button as "left" } : {}),
      ...(event.deltaX !== undefined ? { deltaX: Number(event.deltaX) } : {}),
      ...(event.deltaY !== undefined ? { deltaY: Number(event.deltaY) } : {}),
    };
  }
  if (
    event.kind === "key" &&
    (event.type === "down" || event.type === "up" || event.type === "text") &&
    typeof event.key === "string" &&
    event.key.length > 0 &&
    event.key.length <= 32
  )
    return { kind: "key", type: event.type, key: event.key };
  throw Error("browser_input_invalid");
}

/** B4: marks a card the agent asked for, as opposed to the owner's own takeover. */
export const HELP_MARK = "help-";
/** B6: marks a card holding a pay click for the owner's confirmation. */
export const BUY_MARK = "buy-";
/** Whether the owner holds the browser (not just an open request for help). */
export const owning = (control: string | undefined) =>
  Boolean(control && !control.includes(`:${HELP_MARK}`) && !control.includes(`:${BUY_MARK}`));

/** B4: the agent's `need-human` request; the daemon picks it up and raises a card. */
export const helpFile = (b: Pick<BrowserBinding, "home">) => path.join(b.home, "help.json");
export const HELP_REASONS = ["sign_in", "verification", "payment", "other"] as const;
export type HelpReason = (typeof HELP_REASONS)[number];
export interface HelpRequest {
  reason: HelpReason;
  note: string;
}
/** Notes the agent writes are short; the owner reads them on a card. */
export const HELP_NOTE_MAX = 300;

export function parseHelp(value: unknown): HelpRequest | undefined {
  const row = (value ?? {}) as Record<string, unknown>;
  if (!HELP_REASONS.includes(row.reason as HelpReason)) return undefined;
  const note = typeof row.note === "string" ? row.note.replace(/\s+/g, " ").trim() : "";
  return { reason: row.reason as HelpReason, note: note.slice(0, HELP_NOTE_MAX) };
}
