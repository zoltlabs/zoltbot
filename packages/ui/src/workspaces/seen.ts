import { useSyncExternalStore } from "react";

// When each chat was last looked at, so "Done" and "Failed" show only until you open the chat.
// Kept on this device: reading a chat here says nothing about another device.
const key = "zoltbot.chatSeen.v1";
const limit = 500;
let seen: Record<string, string> = load();
const listeners = new Set<() => void>();

function load(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}");
    return Object.fromEntries(
      Object.entries(saved ?? {}).filter(([, value]) => typeof value === "string"),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Records that the chat was seen now. */
export function markSeen(threadId: string, at = new Date().toISOString()) {
  if ((seen[threadId] ?? "") >= at) return;
  const entries = Object.entries({ ...seen, [threadId]: at })
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, limit);
  seen = Object.fromEntries(entries);
  try {
    localStorage.setItem(key, JSON.stringify(seen));
  } catch {}
  for (const listener of listeners) listener();
}

export function useSeen() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => seen,
  );
}
