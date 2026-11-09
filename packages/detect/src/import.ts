import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ImportItem, type ImportReceipt, ImportReceiptSchema, parse } from "@zoltbot/protocol";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

export type { ImportItem } from "@zoltbot/protocol";
export interface ImportPreview {
  id: string;
  items: ImportItem[];
  counts: Record<ImportItem["kind"], number>;
  errors: { source: string; code: string }[];
}
const briefBytes = 8192;
const skipped = new Set(["node_modules", ".git", "build", "dist", "target", ".cache", "coverage"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function cleanUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of url.searchParams.keys()) url.searchParams.set(key, "[redacted]");
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}
function cleanMcp(value: unknown) {
  const input = record(value),
    output: Record<string, unknown> = {};
  if (typeof input.command === "string") output.command = input.command;
  else if (Array.isArray(input.command) && typeof input.command[0] === "string") {
    output.command = input.command[0];
    output.argumentCount = Math.max(0, input.command.length - 1);
  }
  const url = input.url ?? input.httpUrl;
  if (typeof url === "string") output.url = cleanUrl(url);
  // Arguments can contain credentials without recognizable flag names. Keep only a count.
  if (Array.isArray(input.args)) output.argumentCount = input.args.length;
  for (const field of ["env", "headers"] as const) {
    const names = Object.keys(
      record(field === "env" ? (input.env ?? input.environment) : input[field]),
    );
    if (names.length)
      output[field] = Object.fromEntries(names.map((name) => [name, "[confirmation required]"]));
  }
  return output;
}
export class ImportReader {
  private readonly previews = new Map<string, ImportPreview>();
  constructor(
    private readonly options: {
      home: string;
      dataDir: string;
      onApply?: (receipt: ImportReceipt) => Promise<void>;
    },
  ) {}
  async preview(options: {
    consent: boolean;
    codeFolders?: string[];
    sources?: string[];
  }): Promise<ImportPreview> {
    if (!options.consent) throw new Error("import_consent_required");
    if (
      options.codeFolders &&
      (options.codeFolders.length > 128 ||
        options.codeFolders.some((folder) => !path.isAbsolute(folder)))
    )
      throw new Error("invalid_import_path");
    const preview: ImportPreview = {
      id: randomUUID(),
      items: [],
      counts: { project: 0, session: 0, mcp: 0 },
      errors: [],
    };
    const add = (item: Omit<ImportItem, "id">) => {
      if (preview.items.length >= 10000) return;
      if (
        preview.items.some(
          (other) =>
            other.kind === item.kind &&
            other.source === item.source &&
            other.path === item.path &&
            other.nativePath === item.nativePath &&
            other.scopePath === item.scopePath &&
            other.name === item.name,
        )
      )
        return;
      preview.items.push({ ...item, id: randomUUID() });
      preview.counts[item.kind]++;
    };
    const sources = options.sources ? new Set(options.sources) : undefined;
    const include = (source: string) => !sources || sources.has(source);
    const home = this.options.home;
    const projects = path.join(home, ".claude/projects");
    for (const entry of include("claude") ? await directories(projects) : []) {
      const directory = path.join(projects, entry);
      add({ kind: "project", source: "claude", name: entry, nativePath: directory });
      await sessions(directory, "claude", 0);
    }
    for (const [source, relative] of [
      ["codex", ".codex/sessions"],
      ["grok", ".grok/sessions"],
      ["pi", ".pi/agent/sessions"],
    ] as const)
      if (include(source)) await sessions(path.join(home, relative), source, 3);
    for (const [source, relative] of [
      ["claude", ".claude.json"],
      ["cursor", ".cursor/mcp.json"],
      ["codex", ".codex/config.toml"],
      ["grok", ".grok/config.toml"],
      ["gemini", ".gemini/settings.json"],
      ["opencode", ".config/opencode/opencode.json"],
      ["opencode", ".config/opencode/opencode.jsonc"],
      ["cline", ".cline/data/settings/cline_mcp_settings.json"],
    ] as const)
      if (include(source)) await mcp(path.join(home, relative), source);
    if (include("codex")) {
      const text = await metadata(path.join(home, ".codex/session_index.jsonl"));
      let invalid = false;
      for (const line of text?.split(/\r?\n/) ?? []) {
        if (!line.trim()) continue;
        try {
          const row = record(JSON.parse(line));
          if (typeof row.id !== "string" || typeof row.thread_name !== "string") {
            invalid = true;
            continue;
          }
          const item = preview.items.find(
            (item) =>
              item.kind === "session" && item.source === "codex" && item.nativeId === row.id,
          );
          const name = Array.from(row.thread_name.trim()).slice(0, 200).join("");
          if (item && name) item.name = name;
        } catch {
          invalid = true;
        }
      }
      if (invalid) preview.errors.push({ source: "codex", code: "invalid_session_index" });
    }
    for (const folder of options.codeFolders ?? [])
      if (path.isAbsolute(folder)) await repos(folder, 3);
    await linkSessions(preview.items, projects, home);
    this.previews.set(preview.id, structuredClone(preview));
    while (this.previews.size > 20) this.previews.delete(this.previews.keys().next().value ?? "");
    return preview;
    async function sessions(directory: string, source: string, depth: number) {
      for (const entry of await entries(directory)) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && depth > 0) await sessions(file, source, depth - 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const info = await lstat(file).catch(() => undefined);
          const stem = path.basename(entry.name, ".jsonl");
          const match = ["claude", "codex", "pi"].includes(source)
            ? stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0]
            : undefined;
          if (info?.isFile() && !info.isSymbolicLink())
            add({
              ...(match && (source !== "claude" || stem === match) ? { nativeId: match } : {}),
              kind: "session",
              source,
              name: path.basename(entry.name, ".jsonl"),
              path: file,
              modifiedAt: info.mtimeMs,
              ...(info.size < briefBytes ? { brief: true } : {}),
              ...(source === "codex" ? await codexCwd(file) : {}),
            });
        }
      }
    }
    async function mcp(file: string, source: string) {
      const text = await metadata(file);
      if (text === undefined) return;
      try {
        const errors: ParseError[] = [];
        const value = file.endsWith(".toml")
          ? parseToml(text)
          : parseJsonc(text, errors, { allowTrailingComma: true });
        if (errors.length) throw new Error("invalid_metadata");
        const data = record(value);
        const opencode = record(data.mcp);
        const servers = record(
          source === "opencode"
            ? (opencode.servers ?? opencode)
            : (data.mcpServers ?? data.mcp_servers),
        );
        addServers(servers, source, file);
        const globalProjects =
          (source === "claude" && file === path.join(home, ".claude.json")) ||
          (source === "codex" && file === path.join(home, ".codex/config.toml"));
        if (globalProjects)
          for (const [cwd, project] of Object.entries(record(data.projects))) {
            if (!path.isAbsolute(cwd)) continue;
            const info = await lstat(cwd).catch(() => undefined);
            if (
              info?.isDirectory() &&
              !info.isSymbolicLink() &&
              (await realpath(cwd)) === path.resolve(cwd)
            ) {
              const git = await lstat(path.join(cwd, ".git")).catch(() => undefined);
              add({
                kind: "project",
                source,
                name: path.basename(cwd),
                path: cwd,
                ...(git && !git.isSymbolicLink() ? { repoRoot: cwd } : {}),
              });
            }
            if (source === "claude")
              addServers(record(record(project).mcpServers), source, file, cwd);
          }
      } catch {
        preview.errors.push({ source, code: "invalid_mcp_metadata" });
      }
    }
    function addServers(
      servers: Record<string, unknown>,
      source: string,
      file: string,
      scopePath?: string,
    ) {
      for (const [name, config] of Object.entries(servers)) {
        const configuration = cleanMcp(config);
        if (!("command" in configuration) && !("url" in configuration)) continue;
        add({
          kind: "mcp",
          source,
          name,
          nativePath: file,
          ...(scopePath ? { scopePath } : {}),
          configuration,
        });
      }
    }
    async function repos(directory: string, depth: number) {
      const info = await lstat(directory).catch(() => undefined);
      if (
        !info?.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(directory)) !== path.resolve(directory)
      )
        return;
      const git = await lstat(path.join(directory, ".git")).catch(() => undefined);
      if (git && !git.isSymbolicLink()) {
        if (include("git"))
          add({ kind: "project", source: "git", name: path.basename(directory), path: directory });
        if (include("claude")) await mcp(path.join(directory, ".mcp.json"), "claude");
        if (include("cursor")) await mcp(path.join(directory, ".cursor/mcp.json"), "cursor");
        if (include("gemini")) await mcp(path.join(directory, ".gemini/settings.json"), "gemini");
        if (include("opencode")) {
          await mcp(path.join(directory, "opencode.json"), "opencode");
          await mcp(path.join(directory, "opencode.jsonc"), "opencode");
        }
        return;
      }
      if (depth <= 0) return;
      for (const entry of await directories(directory))
        if (!skipped.has(entry)) await repos(path.join(directory, entry), depth - 1);
    }
  }
  async apply(id: string, selected: string[], consent: boolean) {
    if (!consent) throw new Error("import_consent_required");
    const preview = this.previews.get(id);
    if (!preview) throw new Error("unknown_import_preview");
    const ids = new Set(selected);
    if ([...ids].some((item) => !preview.items.some((candidate) => candidate.id === item)))
      throw new Error("unknown_import_item");
    const result = parse(ImportReceiptSchema, {
      id,
      items: preview.items.filter((item) => ids.has(item.id)),
    });
    await this.options.onApply?.(structuredClone(result));
    const base = await realpath(this.options.dataDir);
    const directory = path.join(base, "imports");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new Error("unsafe_import_directory");
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(result), { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(directory, `${id}.json`));
    return structuredClone(result);
  }
}
/** Codex records the working folder in its first line; nothing past that line is read. */
async function codexCwd(file: string): Promise<{ scopePath?: string }> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return {};
  try {
    const buffer = Buffer.alloc(262144);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "";
    const cwd = record(record(JSON.parse(line)).payload).cwd;
    return typeof cwd === "string" && path.isAbsolute(cwd) ? { scopePath: cwd } : {};
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}
/**
 * Give sessions a working folder, repository root and GitHub name. Claude history folders use a
 * lossy name, so a Claude session only gets a folder when exactly one verified project folder
 * encodes to that name. Transcripts are never opened.
 */
async function linkSessions(items: ImportItem[], claudeProjects: string, home: string) {
  const encoded = new Map<string, string | null>();
  for (const item of items)
    if (item.kind === "project" && item.source === "claude" && item.path) {
      const key = item.path.replace(/[^A-Za-z0-9]/g, "-");
      const known = encoded.get(key);
      encoded.set(key, known === undefined || known === item.path ? item.path : null);
    }
  const roots = new Map<string, Promise<{ repoRoot?: string; remote?: string }>>();
  for (const item of items) {
    if (item.kind !== "session" || !item.path) continue;
    if (item.source === "claude" && path.dirname(path.dirname(item.path)) === claudeProjects) {
      const cwd = encoded.get(path.basename(path.dirname(item.path)));
      if (cwd) item.scopePath = cwd;
    }
    if (!item.scopePath) continue;
    const found = roots.get(item.scopePath) ?? repository(item.scopePath, home);
    roots.set(item.scopePath, found);
    Object.assign(item, await found);
  }
}
async function repository(cwd: string, home: string) {
  let directory = path.resolve(cwd);
  for (let depth = 0; depth < 16; depth++) {
    const git = await lstat(path.join(directory, ".git")).catch(() => undefined);
    if (git && !git.isSymbolicLink()) {
      const remote = git.isDirectory()
        ? githubName((await metadata(path.join(directory, ".git/config"))) ?? "")
        : undefined;
      return { repoRoot: directory, ...(remote ? { remote } : {}) };
    }
    const parent = path.dirname(directory);
    if (parent === directory || directory === home) break;
    directory = parent;
  }
  return {};
}
/** Only the origin remote, and only a GitHub owner/name; any other URL is dropped. */
export function githubName(config: string): string | undefined {
  const origin = config.split(/^\s*\[/m).find((section) => /^remote\s+"origin"\s*\]/.test(section));
  const url = origin?.match(/^\s*url\s*=\s*(\S+)\s*$/m)?.[1];
  const match = url?.match(
    /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/,
  );
  return match?.[1];
}
async function entries(directory: string) {
  const info = await lstat(directory).catch(() => undefined);
  if (
    !info?.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(directory)) !== path.resolve(directory)
  )
    return [];
  return readdir(directory, { withFileTypes: true }).catch(() => []);
}
async function directories(directory: string) {
  return (await entries(directory))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
}
async function metadata(file: string): Promise<string | undefined> {
  const info = await lstat(file).catch(() => undefined);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size > 1048576 ||
    (await realpath(file)) !== path.resolve(file)
  )
    return;
  const handle = await open(file, "r");
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
