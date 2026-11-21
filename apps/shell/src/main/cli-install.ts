// R5: puts a small `zolt` script in /usr/local/bin that runs the app's bundled command with the
// app's own Node. It only ever replaces a script it wrote; macOS asks for an admin password when
// the folder isn't writable.
import type { CliState } from "../shared/cli";

export const CLI_TARGET = "/usr/local/bin/zolt";
const MARKER = "# Installed by Zoltbot.";

export interface CliFiles {
  /** What is at `path`, without following a symlink. */
  kind(path: string): Promise<"missing" | "file" | "link" | "other">;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /**
   * Writes a new file with mode 755, failing if anything is already at `path`. Throws an EACCES
   * error when the folder is locked.
   */
  write(path: string, content: string): Promise<void>;
  /** Removes our own earlier script before it is written again. */
  remove(path: string): Promise<void>;
  /** Copies `source` to `target` as an administrator, after macOS asks for the password. */
  writeAsAdmin(source: string, target: string): Promise<void>;
  temporary(content: string): Promise<string>;
}

/** Single-quoted for sh: safe for any path, including ones with spaces or quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The script. `dataDir` points zolt at the same daemon as this app, such as a dev build's. */
export function cliScript(node: string, script: string, dataDir?: string): string {
  const env = dataDir ? `ZOLTBOT_DATA_DIR=${shellQuote(dataDir)} ` : "";
  return `#!/bin/sh\n${MARKER}\n${env}exec ${shellQuote(node)} ${shellQuote(script)} "$@"\n`;
}

export function cliInstaller(options: {
  files: CliFiles;
  /** The Node and the bundled command this app ships, or undefined when it ships none. */
  source: () => { node: string; script: string; dataDir?: string } | undefined;
  target?: string;
}) {
  const target = options.target ?? CLI_TARGET;
  async function status(): Promise<CliState> {
    const source = options.source();
    if (!source || !(await options.files.exists(source.script))) return "unavailable";
    // A symlink, a folder or a file we can't read is someone else's; only a plain file of ours
    // is ever replaced.
    const kind = await options.files.kind(target);
    if (kind === "missing") return "missing";
    if (kind !== "file") return "other";
    let current: string;
    try {
      current = await options.files.read(target);
    } catch {
      return "other";
    }
    if (!current.includes(MARKER)) return "other";
    return current === cliScript(source.node, source.script, source.dataDir)
      ? "installed"
      : "outdated";
  }
  return {
    status,
    async install(): Promise<CliState> {
      const state = await status();
      // Someone else's zolt stays; an unbuilt app has nothing to install.
      if (state === "other" || state === "unavailable" || state === "installed") return state;
      const source = options.source();
      if (!source) return "unavailable";
      const content = cliScript(source.node, source.script, source.dataDir);
      try {
        if (state === "outdated") await options.files.remove(target);
        await options.files.write(target, content);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EACCES" && code !== "EPERM" && code !== "ENOENT") throw error;
        try {
          await options.files.writeAsAdmin(await options.files.temporary(content), target);
        } catch (admin) {
          // Cancelling the password prompt leaves things as they were, with nothing to report.
          if ((admin as NodeJS.ErrnoException).code !== "ECANCELED") throw admin;
        }
      }
      return status();
    },
  };
}
