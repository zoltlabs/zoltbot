import { createRoot, createSignal } from "solid-js";
import type { SendKeyPreference } from "../../../shared/preferences";

// C14: Enter or ⌘ Enter sends; the other key adds a new line. ⌥ Enter still asks aside.

const [sendKey, setSendKey] = createRoot(() => createSignal<SendKeyPreference>("enter"));
export { sendKey };

let started = false;
/** Reads the preference once and follows later changes from any window. */
export function followSendKey(): void {
  if (started) return;
  started = true;
  const preferences = window.openbot?.preferences;
  if (!preferences) return;
  void preferences
    .get()
    .then((value) => setSendKey(value.sendKey))
    .catch(() => undefined);
  preferences.onChange((value) => setSendKey(value.sendKey));
}

export function chooseSendKey(next: SendKeyPreference): void {
  setSendKey(next);
  void window.openbot?.preferences?.set({ sendKey: next }).catch(() => undefined);
}

/** What Enter does in the composer: send, add a line, or nothing for other keys. */
export function enterAction(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  mode: SendKeyPreference,
): "send" | "newline" | undefined {
  if (event.key !== "Enter") return undefined;
  if (event.shiftKey) return "newline";
  if (event.altKey) return "send";
  const mod = event.metaKey || event.ctrlKey;
  if (mode === "mod-enter") return mod ? "send" : "newline";
  return "send";
}
