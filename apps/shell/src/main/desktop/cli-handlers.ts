// R5: the desktop's "Install command-line tool": real files for cli-install, and its IPC.
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CLI_CHANNELS } from "../../shared/cli";
import { type CliFiles, cliInstaller } from "../cli-install";

const run = promisify(execFile);

// Paths travel as arguments, never inside the AppleScript text. As root it refuses a symlink at
// either end, and install(1) replaces the target rather than writing through it.
const ADMIN_COPY = [
  "on run argv",
  "set source to quoted form of item 1 of argv",
  "set target to quoted form of item 2 of argv",
  'do shell script "test ! -L " & source & " && test ! -L " & target & " && mkdir -p " & quoted form of item 3 of argv & " && /usr/bin/install -m 755 " & source & " " & target with administrator privileges',
  "end run",
];

const files: CliFiles = {
  async kind(path) {
    try {
      const info = await lstat(path);
      return info.isSymbolicLink() ? "link" : info.isFile() ? "file" : "other";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "other";
    }
  },
  read: (path) => readFile(path, "utf8"),
  remove: (path) => unlink(path),
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  async write(path, content) {
    // "wx" fails on anything already there, a planted symlink included.
    await writeFile(path, content, { mode: 0o755, flag: "wx" });
    await chmod(path, 0o755);
  },
  async writeAsAdmin(source, target) {
    try {
      await run("/usr/bin/osascript", [
        ...ADMIN_COPY.flatMap((line) => ["-e", line]),
        source,
        target,
        dirname(target),
      ]);
    } catch (error) {
      // -128 is AppleScript's "User canceled" from the password prompt.
      if (String((error as { stderr?: unknown }).stderr ?? "").includes("(-128)"))
        throw Object.assign(new Error("cancelled"), { code: "ECANCELED" });
      throw error;
    } finally {
      await rm(dirname(source), { recursive: true, force: true });
    }
  },
  async temporary(content) {
    const folder = await mkdtemp(join(tmpdir(), "zolt-"));
    const path = join(folder, "zolt");
    await writeFile(path, content, { mode: 0o755 });
    return path;
  },
};

/** Packaged apps run zolt.mjs with their own Node; a dev build runs the built one directly. */
export function cliHandlers(options: { packaged: boolean; root: string; dataDir: string }) {
  const installer = cliInstaller({
    files,
    source: () =>
      options.packaged
        ? { node: join(options.root, "bin/node"), script: join(options.root, "zolt.mjs") }
        : {
            // The built script starts with #!/usr/bin/env node.
            node: "/usr/bin/env",
            script: join(options.root, "apps/cli/dist/zolt.mjs"),
            dataDir: options.dataDir,
          },
  });
  return {
    [CLI_CHANNELS.cliStatus]: () => installer.status(),
    [CLI_CHANNELS.cliInstall]: () => installer.install(),
  };
}
