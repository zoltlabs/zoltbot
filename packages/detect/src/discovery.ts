import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { type CommandRunner, type RunOptions, runCommand } from "./process.js";
import {
  compareVersions,
  type SupportStatus,
  supportStatus,
  versionFromOutput,
} from "./versions.js";

export class LoginPath {
  private cached?: Promise<string[]>;
  constructor(private readonly runner: CommandRunner = runCommand) {}
  resolve(shell: string, options: RunOptions): Promise<string[]> {
    this.cached ??= this.read(shell, options);
    return this.cached;
  }
  private async read(shell: string, options: RunOptions) {
    const name = path.basename(shell);
    if (!["zsh", "bash", "fish", "sh"].includes(name)) return this.fallback(options);
    const script =
      name === "fish"
        ? "printf 'ZOLTBOT_PATH=%s\\n' (string join : $PATH)"
        : "printf 'ZOLTBOT_PATH=%s\\n' \"$PATH\"";
    const result = await this.runner(shell, ["-lc", script], { ...options, timeoutMs: 5000 });
    if (result.failure || result.code !== 0) return this.fallback(options);
    const line = result.stdout.split(/\r?\n/).findLast((line) => line.startsWith("ZOLTBOT_PATH="));
    return line
      ? line.slice(13).split(path.delimiter).filter(path.isAbsolute)
      : this.fallback(options);
  }
  private fallback(options: RunOptions) {
    return (options.inherited?.PATH ?? "").split(path.delimiter).filter(path.isAbsolute);
  }
}
export interface BinaryCandidate {
  path: string;
  source: "override" | "path" | "known" | "package_manager";
  state: "working" | "broken";
  version?: string;
  support: SupportStatus;
  error?: string;
}
export interface DiscoveryOptions {
  binaryNames: string[];
  versionCommand: string[];
  testedVersions: string;
  blockedVersions?: string[];
  override?: string;
  path: string[];
  knownDirectories: string[];
  cwd: string;
  runner?: CommandRunner;
  inherited?: NodeJS.ProcessEnv;
  fallback?: () => Promise<string[]>;
}
export async function discoverBinaries(options: DiscoveryOptions) {
  const runner = options.runner ?? runCommand;
  const candidates: BinaryCandidate[] = [];
  const seen = new Set<string>();
  const inspect = async (file: string, source: BinaryCandidate["source"]) => {
    if (!path.isAbsolute(file) || seen.has(file)) return;
    seen.add(file);
    const exists = await stat(file).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!exists && source !== "override") return;
    const result = exists
      ? await runner(file, options.versionCommand, {
          cwd: options.cwd,
          ...(options.inherited ? { inherited: options.inherited } : {}),
          timeoutMs: 5000,
        })
      : { code: null, stdout: "", stderr: "", failure: "not_found" as const };
    const version = versionFromOutput(result.stdout) ?? versionFromOutput(result.stderr);
    const error =
      result.failure ??
      (result.code !== 0 ? "version_failed" : !version ? "version_unrecognized" : undefined);
    candidates.push({
      path: file,
      source,
      state: error ? "broken" : "working",
      support: supportStatus(version, options.testedVersions, options.blockedVersions),
      ...(version ? { version } : {}),
      ...(error ? { error } : {}),
    });
  };
  if (options.override) await inspect(options.override, "override");
  for (const [source, directories] of [
    ["path", options.path],
    ["known", options.knownDirectories],
  ] as const) {
    for (const directory of directories)
      for (const name of options.binaryNames) await inspect(path.join(directory, name), source);
  }
  if (!candidates.some((item) => item.state === "working") && options.fallback) {
    for (const file of await options.fallback()) await inspect(file, "package_manager");
  }
  const working = candidates.filter((item) => item.state === "working");
  const tested = working
    .filter((item) => item.support === "tested")
    .sort((a, b) => compareVersions(b.version ?? "0.0.0", a.version ?? "0.0.0"));
  const selected = working.find((item) => item.source === "override") ?? tested[0] ?? working[0];
  return { candidates, ...(selected ? { selected } : {}) };
}
export async function knownDirectories(home: string) {
  const fixed = [
    ".local/bin",
    ".bun/bin",
    ".cargo/bin",
    ".npm-global/bin",
    ".local/share/pnpm",
    "Library/pnpm",
    ".volta/bin",
  ].map((item) => path.join(home, item));
  const versioned: string[] = [];
  for (const root of [
    path.join(home, ".nvm/versions/node"),
    path.join(home, ".local/share/fnm/node-versions"),
    path.join(home, "Library/Application Support/fnm/node-versions"),
  ]) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if (entry.isDirectory())
        versioned.push(
          path.join(root, entry.name, root.includes("fnm") ? "installation/bin" : "bin"),
        );
  }
  return [...fixed, "/opt/homebrew/bin", "/usr/local/bin", ...versioned];
}
