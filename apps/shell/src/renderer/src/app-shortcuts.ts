// The app's one shortcut registry and its single keydown listener. Components
// register with useShortcut, which starts the listener; rebound keys come from preferences (F6).
import { onCleanup } from "solid-js";
import { createShortcutRegistry, type Shortcut, type ShortcutRegistry } from "./shortcuts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const shortcuts: ShortcutRegistry = createShortcutRegistry({ isMac });

/**
 * Starts dispatching keydown events to the registry and follows rebound keys in preferences.
 * Returns a function that stops both.
 */
export function installShortcuts(target: Window = window): () => void {
  const keydown = (event: KeyboardEvent) => {
    shortcuts.handle(event);
  };
  target.addEventListener("keydown", keydown);
  const preferences = target.openbot?.preferences;
  void preferences
    ?.get()
    .then((saved) => shortcuts.setBindings(saved.keyBindings))
    .catch(() => undefined);
  const unsubscribe = preferences?.onChange((saved) => shortcuts.setBindings(saved.keyBindings));
  return () => {
    target.removeEventListener("keydown", keydown);
    unsubscribe?.();
  };
}

let installed = false;

/**
 * Registers a shortcut for as long as the calling component is mounted. The first one starts
 * the app's keydown listener, which then stays for the life of the page.
 */
export function useShortcut(shortcut: Shortcut): void {
  if (!installed && typeof window !== "undefined") {
    installed = true;
    installShortcuts(window);
  }
  onCleanup(shortcuts.register(shortcut));
}
