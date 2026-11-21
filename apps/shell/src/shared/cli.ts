// R5: installing the zolt command from the desktop.

export const CLI_CHANNELS = {
  cliStatus: "cli:status",
  cliInstall: "cli:install",
} as const;

/** "installed": zolt points at this app. "other": a zolt that isn't ours is in the way. */
export type CliState = "missing" | "installed" | "outdated" | "other" | "unavailable";

export interface CliDesktopApi {
  status: () => Promise<CliState>;
  install: () => Promise<CliState>;
}
