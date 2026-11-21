// D6: Start fresh, main's half. The daemon removes saved logins and marks its data folder; main
// stops it, deletes the app's own settings and relaunches, and the daemon empties its folder as
// it starts.
import { rm } from "node:fs/promises";
import { START_FRESH_CHANNELS, START_FRESH_PHRASE } from "../shared/start-fresh";

export interface StartFreshDeps {
  interruptAll: () => Promise<void>;
  /** Signs out of the Zoltbot account, which ends its session on the server too. */
  signOut: () => Promise<void>;
  call: (method: string, params: unknown) => Promise<unknown>;
  /** Stops the service connection and the daemon, even one another window started. */
  stopDaemon: () => Promise<void>;
  /** The app's own files: preferences, setup and the like. */
  appFiles: () => string[];
  /** Clears the windows' local storage and caches. */
  clearStorage: () => Promise<void>;
  relaunch: () => void;
}

export function startFreshHandlers(
  deps: StartFreshDeps,
): Record<string, (input: unknown) => unknown> {
  let marked = false;
  return {
    [START_FRESH_CHANNELS.run]: async (input) => {
      if (input !== START_FRESH_PHRASE) throw new Error("start_fresh_not_confirmed");
      await deps.interruptAll().catch(() => undefined);
      await deps.signOut().catch(() => undefined);
      const result = (await deps.call("maintenance.startFresh", {
        confirm: START_FRESH_PHRASE,
      })) as {
        kept?: unknown;
      };
      marked = true;
      // Marked now, so if the owner quits instead of restarting, the next start is fresh too.
      for (const file of deps.appFiles()) await rm(file, { force: true, recursive: true });
      await deps.clearStorage().catch(() => undefined);
      return {
        kept: Array.isArray(result?.kept)
          ? result.kept.filter((item): item is string => typeof item === "string")
          : [],
      };
    },
    [START_FRESH_CHANNELS.restart]: async () => {
      if (!marked) throw new Error("start_fresh_not_run");
      await deps.stopDaemon();
      deps.relaunch();
    },
  };
}
