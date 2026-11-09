import { useSyncExternalStore } from "react";

// How chats read on this device: as a chat timeline or as letters, like the Inbox.
export type ThreadView = "chat" | "letters";
const key = "zoltbot.threadView.v1";
const listeners = new Set<() => void>();
let view: ThreadView = load();

function load(): ThreadView {
  try {
    return localStorage.getItem(key) === "letters" ? "letters" : "chat";
  } catch {
    return "chat";
  }
}

export function setThreadView(next: ThreadView) {
  view = next;
  try {
    localStorage.setItem(key, next);
  } catch {}
  for (const listener of listeners) listener();
}

export function useThreadView() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => view,
  );
}
