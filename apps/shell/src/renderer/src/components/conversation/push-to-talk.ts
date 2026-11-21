// O3: hold a key to dictate into the composer; let go to stop, and to send when that's on.
// The key machine is pure so its timing and chords are tested without a keyboard.

import { onCleanup } from "solid-js";
import type { PushToTalkKey } from "../../../../shared/preferences";
import { voicePreferences } from "./read-aloud";

export type { PushToTalkKey };

/** Held this long with no other key, the key starts listening; a tap or a chord never does. */
export const MIN_HOLD_MS = 250;

export type HoldInput =
  | { type: "down"; code: string; repeat: boolean; at: number }
  | { type: "up"; code: string; at: number }
  /** Time passing while held; the hook sends one when MIN_HOLD_MS is up. */
  | { type: "tick"; at: number }
  | { type: "blur" };

/** start: begin listening. stop: finish and keep the words. cancel: drop them. */
export type HoldOutput = "start" | "stop" | "cancel";

export class HoldKey {
  private held: { at: number; started: boolean } | undefined;
  // Another key went down while held, as in Fn+arrow or ⌥E: stay idle until the key is let go.
  private chord = false;

  constructor(private readonly key: () => PushToTalkKey) {}

  get holding(): boolean {
    return Boolean(this.held);
  }

  handle(input: HoldInput): HoldOutput | undefined {
    const key = this.key();
    if (key === "off") return this.release("cancel");
    if (input.type === "blur") {
      // The window lost focus, perhaps to a permission sheet: nothing is sent behind the owner's back.
      this.chord = false;
      return this.release("cancel");
    }
    if (input.type === "tick") {
      const held = this.held;
      if (!held || held.started || input.at - held.at < MIN_HOLD_MS) return undefined;
      held.started = true;
      return "start";
    }
    if (input.type === "down") {
      if (input.code === key) {
        if (input.repeat || this.held || this.chord) return undefined;
        this.held = { at: input.at, started: false };
        return undefined;
      }
      // A shortcut with the key held isn't talking.
      if (this.held) {
        this.chord = true;
        return this.release("cancel");
      }
      return undefined;
    }
    if (input.code !== key) return undefined;
    this.chord = false;
    return this.release("stop");
  }

  /** Ends a hold; one that never started listening has nothing to stop or drop. */
  private release(output: HoldOutput): HoldOutput | undefined {
    const held = this.held;
    this.held = undefined;
    return held?.started ? output : undefined;
  }
}

interface Dictating {
  available: () => boolean;
  active: () => boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => void;
}

/**
 * Holding the push-to-talk key dictates into the open chat's composer while the window has focus.
 * Letting go stops; with "Send when released" on, the words are sent once the last of them lands.
 */
export function followPushToTalk(options: {
  dictation: Dictating;
  /** False while something else has the microphone, such as a call, or no chat is open. */
  ready: () => boolean;
  onSend: () => void;
}): { idle: (finished: boolean) => void } {
  const prefs = voicePreferences;
  const hold = new HoldKey(() => prefs().pushToTalkKey);
  // Only a session this key started is stopped, dropped or sent; the mic button's is left alone.
  let mine = false;
  let sendWhenDone = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const act = (output: HoldOutput | undefined) => {
    if (output === "start") {
      if (!options.ready() || busyElsewhere() || options.dictation.active()) return;
      if (!options.dictation.available()) return;
      mine = true;
      sendWhenDone = false;
      void options.dictation.start();
    } else if (output === "stop" && mine) {
      sendWhenDone = prefs().sendOnRelease;
      void options.dictation.stop();
    } else if (output === "cancel" && mine) {
      mine = false;
      options.dictation.cancel();
    }
  };
  const down = (event: KeyboardEvent) => {
    const was = hold.holding;
    act(hold.handle({ type: "down", code: event.code, repeat: event.repeat, at: Date.now() }));
    if (was || !hold.holding) return;
    // A new hold: its own timer, not one left from a tap just before.
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      act(hold.handle({ type: "tick", at: Date.now() }));
    }, MIN_HOLD_MS);
  };
  const up = (event: KeyboardEvent) =>
    act(hold.handle({ type: "up", code: event.code, at: Date.now() }));
  const blur = () => act(hold.handle({ type: "blur" }));
  window.addEventListener("keydown", down, true);
  window.addEventListener("keyup", up, true);
  window.addEventListener("blur", blur);
  onCleanup(() => {
    clearTimeout(timer);
    window.removeEventListener("keydown", down, true);
    window.removeEventListener("keyup", up, true);
    window.removeEventListener("blur", blur);
  });
  return {
    idle: (finished) => {
      const send = mine && finished && sendWhenDone;
      mine = false;
      sendWhenDone = false;
      if (send) options.onSend();
    },
  };
}

/** A dialog or menu is open, or another field has focus: the composer isn't where words go. */
function busyElsewhere(): boolean {
  if (document.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"]')) return true;
  const focused = document.activeElement as HTMLElement | null;
  if (!focused || focused === document.body || focused.closest(".composer-wrap")) return false;
  return focused.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName);
}
