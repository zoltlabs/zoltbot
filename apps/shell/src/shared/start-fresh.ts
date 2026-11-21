// D6: Start fresh deletes every agent, chat, task, memory, setting and saved login on this Mac.

export const START_FRESH_CHANNELS = {
  run: "start-fresh:run",
  restart: "start-fresh:restart",
} as const;

/** What the owner types to confirm. */
export const START_FRESH_PHRASE = "start fresh";

export interface StartFreshDesktopApi {
  /** Stops the work and removes saved logins. Returns the project folders it leaves alone. */
  run: (confirm: string) => Promise<{ kept: string[] }>;
  /** Deletes the rest and restarts into first run. */
  restart: () => Promise<void>;
}

/**
 * Whether the typed text confirms: the phrase in the interface's language, or in English.
 * Case and outer spaces don't matter.
 */
export function confirmsStartFresh(typed: string, shown: string = START_FRESH_PHRASE): boolean {
  // NFC, so a phrase with accents matches however the keyboard composed them.
  const text = typed.normalize("NFC").trim().toLowerCase();
  return text === START_FRESH_PHRASE || text === shown.normalize("NFC").trim().toLowerCase();
}
