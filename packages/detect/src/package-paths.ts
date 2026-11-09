import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CommandRunner, runCommand } from "./process.js";
export async function findPackageDirectories(options: {
  cwd: string;
  home: string;
  paths: string[];
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
}) {
  const cache = await mkdtemp(path.join(options.home, "package-manager-"));
  try {
    const userConfig = path.join(cache, "user.npmrc"),
      globalConfig = path.join(cache, "global.npmrc");
    for (const file of [userConfig, globalConfig])
      await writeFile(file, "", { mode: 0o600, flag: "wx" });
    const runner = options.runner ?? runCommand;
    const env = {
      HOME: options.home,
      PATH: options.paths.join(path.delimiter),
      TMPDIR: cache,
      npm_config_cache: path.join(cache, "npm"),
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
      HOMEBREW_NO_AUTO_UPDATE: "1",
      HOMEBREW_NO_ANALYTICS: "1",
      HOMEBREW_NO_INSTALL_CLEANUP: "1",
      HOMEBREW_CACHE: path.join(cache, "brew"),
    };
    const queries = [
      {
        command: "npm",
        args: [
          "root",
          "--global",
          "--offline",
          `--userconfig=${userConfig}`,
          `--globalconfig=${globalConfig}`,
        ],
      },
      { command: "brew", args: ["--prefix"] },
    ];
    const results = await Promise.allSettled(
      queries.map(({ command, args }) =>
        runner(command, args, {
          cwd: options.cwd,
          inherited: {},
          env,
          timeoutMs: 5000,
          maxOutputBytes: 16384,
        }),
      ),
    );
    const directories: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status !== "fulfilled" || result.value.failure || result.value.code !== 0)
        continue;
      const root = result.value.stdout.trim();
      if (!path.isAbsolute(root) || /[\r\n\0]/.test(root)) continue;
      if (index === 0)
        directories.push(
          (options.platform ?? process.platform) === "win32"
            ? path.dirname(root)
            : path.resolve(root, "../../bin"),
        );
      else directories.push(path.join(root, "bin"));
    }
    return [...new Set(directories)];
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}
