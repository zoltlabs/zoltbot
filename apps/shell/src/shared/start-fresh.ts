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

/** Whether the typed text confirms. Case and outer spaces don't matter. */
export function confirmsStartFresh(typed: string): boolean {
  return typed.trim().toLowerCase() === START_FRESH_PHRASE;
}
