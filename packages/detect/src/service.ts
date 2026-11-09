import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentDefinition, ImportReceipt } from "@zoltbot/protocol";
import { loadDefinitions, parseDefinition } from "./definitions.js";
import { discoverBinaries, knownDirectories, LoginPath } from "./discovery.js";
import { ImportReader } from "./import.js";
import { checkLogin } from "./login.js";
import { findPackageDirectories } from "./package-paths.js";
import { type ProbeSandbox, probeCommand } from "./probe.js";
import { type CommandRunner, runCommand } from "./process.js";
import { type Fetcher, fetchLatest, type UpdateRow, updateRow } from "./updates.js";
export interface ScanRow {
  definitionId: string;
  displayName: string;
  install: Awaited<ReturnType<typeof discoverBinaries>>;
  unavailableReason?: string;
}
export interface FixHost {
  run(definition: AgentDefinition, action: string): Promise<{ processId?: string }>;
}
export interface DetectionOptions {
  dataDir: string;
  home: string;
  builtins: AgentDefinition[];
  paths?: string[];
  knownPaths?: string[];
  shell?: string;
  runner?: CommandRunner;
  preference?: () => unknown;
  overrides?: () => Record<string, string>;
  keyConfigured?: (definition: AgentDefinition) => Promise<boolean>;
  sandbox?: ProbeSandbox;
  fixes?: FixHost;
  onApply?: (receipt: ImportReceipt) => Promise<void>;
  runtime?: (definitionId: string) => unknown;
  globalChecks?: () => Promise<unknown[]>;
  /** False turns off the daily release lookup. */
  updateChecks?: () => boolean;
  fetch?: Fetcher;
  now?: () => number;
}
const day = 24 * 60 * 60 * 1000,
  retry = 60 * 60 * 1000;
export class DetectionService {
  readonly imports: ImportReader;
  private readonly runner: CommandRunner;
  private readonly loginPath: LoginPath;
  private scans: ScanRow[] = [];
  private readonly changes: { definitionId: string; code: string; from?: string; to?: string }[] =
    [];
  /** Latest published versions, looked up at most once a day (once an hour after a failure). */
  private readonly releases = new Map<string, { at: number; version?: string }>();
  private readonly updating = new Set<string>();
  constructor(private readonly options: DetectionOptions) {
    this.runner = options.runner ?? runCommand;
    this.loginPath = new LoginPath(this.runner);
    this.imports = new ImportReader(options);
  }
  async definitions() {
    return loadDefinitions(
      this.options.builtins,
      this.options.dataDir,
      this.options.preference?.(),
    );
  }
  async paths() {
    return (
      this.options.paths ??
      this.loginPath.resolve(this.options.shell ?? process.env.SHELL ?? "/bin/zsh", {
        cwd: this.options.dataDir,
        inherited: { HOME: this.options.home, PATH: process.env.PATH },
      })
    );
  }
  async scan(requestedPaths?: string[]): Promise<ScanRow[]> {
    const { definitions } = await this.definitions();
    if (
      requestedPaths &&
      (requestedPaths.length > 128 || requestedPaths.some((item) => !path.isAbsolute(item)))
    )
      throw new Error("invalid_scan_paths");
    const paths = requestedPaths ?? (await this.paths());
    const known = this.options.knownPaths ?? (await knownDirectories(this.options.home));
    const versionHome = path.join(this.options.dataDir, "detection-home");
    await mkdir(versionHome, { recursive: true, mode: 0o700 });
    if ((await lstat(versionHome)).isSymbolicLink()) throw new Error("unsafe_detection_home");
    const versionRunner: CommandRunner = (command, args, options) =>
      this.runner(command, args, {
        ...options,
        inherited: { HOME: versionHome, PATH: paths.join(path.delimiter), TMPDIR: versionHome },
        env: {
          XDG_CONFIG_HOME: path.join(versionHome, ".config"),
          XDG_DATA_HOME: path.join(versionHome, ".local/share"),
          XDG_STATE_HOME: path.join(versionHome, ".local/state"),
          XDG_CACHE_HOME: path.join(versionHome, ".cache"),
        },
      });
    let packageDirectories: Promise<string[]> | undefined;
    const packageCandidates = async (names: string[]) => {
      packageDirectories ??= findPackageDirectories({
        cwd: this.options.dataDir,
        home: versionHome,
        paths: [...new Set([...paths, ...known])],
        runner: this.runner,
      });
      return (await packageDirectories).flatMap((directory) =>
        names.map((name) => path.join(directory, name)),
      );
    };
    const results: ScanRow[] = [];
    for (const definition of definitions) {
      const override = this.options.overrides?.()[definition.id];
      const install = await discoverBinaries({
        binaryNames: definition.binaryNames,
        versionCommand: definition.versionCommand,
        testedVersions: definition.testedVersions,
        ...(override ? { override } : {}),
        path: paths,
        knownDirectories: known,
        cwd: this.options.dataDir,
        runner: versionRunner,
        fallback: () => packageCandidates(definition.binaryNames),
      });
      const previous = this.scans.find((item) => item.definitionId === definition.id)?.install
        .selected;
      if (previous && previous.version !== install.selected?.version) {
        this.changes.push({
          definitionId: definition.id,
          code: install.selected ? "version_changed" : "install_removed",
          ...(previous.version ? { from: previous.version } : {}),
          ...(install.selected?.version ? { to: install.selected.version } : {}),
        });
        if (this.changes.length > 100) this.changes.shift();
      }
      results.push({ definitionId: definition.id, displayName: definition.displayName, install });
    }
    this.scans = results;
    return structuredClone(results);
  }
  async login(definitionId: string) {
    const definition = await this.definition(definitionId);
    const configured = (await this.options.keyConfigured?.(definition)) ?? false;
    const selected = this.scans.find((item) => item.definitionId === definitionId)?.install
      .selected;
    if (!selected)
      return { state: configured ? ("api_key_configured" as const) : ("unknown" as const) };
    const args = definition.auth?.statusCommand;
    const result = await checkLogin({
      adapter: definition.flavor ?? definition.adapter,
      command: selected.path,
      ...(args ? { args } : {}),
      cwd: this.options.dataDir,
      apiKeyConfigured: configured,
      runner: this.runner,
    });
    return result.plan ? { state: result.state, plan: result.plan } : { state: result.state };
  }
  async report(): Promise<{ checks: unknown[] }> {
    const definitions = await this.definitions();
    const checks: unknown[] = [];
    for (const scan of this.scans) {
      const definition = definitions.definitions.find((item) => item.id === scan.definitionId);
      if (!definition) continue;
      const runtime = this.options.runtime?.(scan.definitionId) ?? { state: "unknown" };
      const evidence =
        runtime && typeof runtime === "object" ? (runtime as Record<string, unknown>) : {};
      const capabilities =
        evidence.capabilities && typeof evidence.capabilities === "object"
          ? (evidence.capabilities as Record<string, unknown>)
          : definition.staticCapabilities;
      checks.push({
        kind: "agent",
        ...scan,
        login: await this.login(scan.definitionId),
        overridden: definitions.overridden.includes(scan.definitionId),
        capabilities,
        runtime,
        hostTools: capabilities.hostTools ?? "unknown",
      });
    }
    checks.push(...this.changes.map((change) => ({ kind: "change", ...change })));
    checks.push(...definitions.errors.map((error) => ({ kind: "definition", ...error })));
    const disk = await statfs(this.options.dataDir).catch(() => undefined);
    const permissions = await lstat(this.options.dataDir).catch(() => undefined);
    checks.push({
      kind: "global",
      id: "disk",
      state: disk ? "available" : "unknown",
      ...(disk ? { availableBytes: disk.bavail * disk.bsize } : {}),
    });
    checks.push({
      kind: "global",
      id: "file_permissions",
      state: permissions && (permissions.mode & 0o077) === 0 ? "private" : "check_required",
    });
    checks.push(
      { kind: "global", id: "keychain", state: "unknown" },
      { kind: "global", id: "notifications", state: "unknown" },
    );
    checks.push(...((await this.options.globalChecks?.()) ?? []));
    return { checks };
  }
  async upsert(value: unknown) {
    const definition = parseDefinition(value);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(definition.id) ||
      !["claude", "codex", "acp", "pi"].includes(definition.adapter)
    )
      throw new Error("invalid_definition");
    const loaded = await this.definitions();
    if (loaded.duplicateIds.includes(definition.id)) throw new Error("duplicate_definition");
    const directory = path.join(this.options.dataDir, "definitions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== path.join(await realpath(this.options.dataDir), "definitions")
    )
      throw new Error("unsafe_definition_file");
    const existing = Object.hasOwn(loaded.sourceFiles, definition.id)
      ? loaded.sourceFiles[definition.id]
      : undefined;
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(definition, null, 2), { flag: "wx", mode: 0o600 });
    await rename(
      temporary,
      path.join(directory, existing ?? `${encodeURIComponent(definition.id)}.json`),
    );
    return definition;
  }
  async updates(): Promise<UpdateRow[]> {
    if (this.options.updateChecks?.() === false) return [];
    const { definitions } = await this.definitions();
    if (!this.scans.length) await this.scan();
    const now = (this.options.now ?? Date.now)();
    const rows: UpdateRow[] = [];
    for (const definition of definitions) {
      const selected = this.scans.find((item) => item.definitionId === definition.id)?.install
        .selected;
      if (!definition.update || !selected?.version) continue;
      let release = this.releases.get(definition.id);
      if (!release || now - release.at >= (release.version ? day : retry)) {
        const version = await fetchLatest(definition.update.latest, this.options.fetch).catch(
          () => undefined,
        );
        release = { at: now, ...(version ? { version } : {}) };
        this.releases.set(definition.id, release);
      }
      const row = updateRow(definition, selected, release.version);
      if (row) rows.push(row);
    }
    return rows;
  }
  /** Runs the provider's own update command for the selected install, then rescans. */
  async update(definitionId: string, confirmed: boolean) {
    if (!confirmed) throw new Error("update_confirmation_required");
    const definition = await this.definition(definitionId);
    const selected = this.scans.find((item) => item.definitionId === definitionId)?.install
      .selected;
    if (!definition.update || !selected) throw new Error("update_unavailable");
    if (this.updating.has(definitionId)) throw new Error("update_in_progress");
    this.updating.add(definitionId);
    try {
      const result = await this.runner(selected.path, definition.update.args, {
        cwd: this.options.dataDir,
        inherited: {
          ...process.env,
          HOME: this.options.home,
          PATH: (await this.paths()).join(path.delimiter),
        },
        timeoutMs: 10 * 60 * 1000,
      });
      await this.scan();
      if (result.failure || result.code !== 0) throw new Error("update_failed");
      const version = this.scans.find((item) => item.definitionId === definitionId)?.install
        .selected?.version;
      return version ? { version } : {};
    } finally {
      this.updating.delete(definitionId);
    }
  }
  probe(command: string) {
    return probeCommand(command, this.options.sandbox);
  }
  async fix(definitionId: string, action: string, confirmed: boolean) {
    if (!confirmed) throw new Error("fix_confirmation_required");
    if (
      !["install", "update", "login", "restart", "reset", "choose_install", "frame_log"].includes(
        action,
      )
    )
      throw new Error("unknown_fix");
    const definition = await this.definition(definitionId);
    if (!this.options.fixes) throw new Error("visible_fix_host_unavailable");
    return this.options.fixes.run(definition, action);
  }
  private async definition(id: string) {
    const definition = (await this.definitions()).definitions.find((item) => item.id === id);
    if (!definition) throw new Error("unknown_definition");
    return definition;
  }
}
