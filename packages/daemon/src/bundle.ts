// D7: move to another computer. Export agents, memory, skills, routines, channels, the company
// and settings to a ZIP, and import it on another Mac. Chats stay with their providers'
// sessions, saved logins stay in this Mac's keychain, and connections travel by name only.
import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import type { DomainEvent } from "@zoltbot/protocol";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { parseSkill, type SkillBundle, SkillsLibrary } from "../../skills/src/index.js";

export const BUNDLE_FORMAT = 1;
/** The entity kinds a bundle carries, in the order they import: parents before children. */
export const BUNDLE_KINDS = [
  "project",
  "subproject",
  "area",
  "agent",
  "knowledge",
  "channel",
  "routine",
] as const;
export type BundleKind = (typeof BUNDLE_KINDS)[number];

/**
 * Settings that belong to this Mac, hold private state or point at programs and folders: never
 * exported or imported. Sign-in folders (`models.`), connection configs (`mcp.`) and worktree
 * folders could run code or leak paths on the other Mac.
 */
const LOCAL_SETTING_PREFIXES = [
  "runtime.",
  "bridge.",
  "fork.",
  "chat.",
  "view.",
  "routine.",
  "link.",
  "limits.",
  "knowledge.exclusions.",
  "identity.",
  "account.",
  "device.",
  "models.",
  "chief.",
  "mcp.",
  "connection.",
  "worktree.",
  "cloud.",
  "skills.libraryRevision",
];

/** Fields that run commands on this Mac or name its folders: left out of every row. */
const LOCAL_FIELDS = new Set([
  "setupScript",
  "previewCommand",
  "roots",
  "repoRoot",
  "designFiles",
  "configDirectory",
  "scopePath",
]);

/** Largest bundle read, packed or unpacked: well above any real one, so a bad file can't fill memory. */
export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;

type Row = Record<string, unknown> & { id: string };

export interface BundleData {
  manifest: {
    format: number;
    exportedAt: string;
    counts: Record<string, number>;
    /** Connections by name; their sign-ins don't travel. */
    connections: string[];
  };
  entities: Partial<Record<BundleKind, Row[]>>;
  /** The coding tools the agents run on, by id and name only: the other Mac sets them up itself. */
  definitions: { id: string; displayName: string }[];
  settings: { key: string; value: unknown }[];
  skills: { name: string; files: SkillBundle["files"] }[];
}

const SECRET = /keychain:|^sk-|token|secret|password/i;

const SECRET_FIELD = /(credential|secret|password|apiKey|token)s?$/i;

/**
 * A copy of `value` without keychain references, fields named like credentials, or fields that
 * run commands or name this Mac's folders.
 */
export function withoutSecrets<T>(value: T): T {
  const clean = (item: unknown): unknown => {
    if (typeof item === "string") return item.startsWith("keychain:") ? undefined : item;
    if (Array.isArray(item)) return item.map(clean).filter((entry) => entry !== undefined);
    if (item && typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item)) {
        if (SECRET_FIELD.test(key) || LOCAL_FIELDS.has(key)) continue;
        const next = clean(entry);
        if (next !== undefined) out[key] = next;
      }
      return out;
    }
    return item;
  };
  return clean(value) as T;
}

/** A string that names a folder or file on this Mac. */
const LOCAL_PATH = /"(\/|~\/|[A-Za-z]:\\)/;

function localSetting(key: string, value: unknown): boolean {
  const text = JSON.stringify(value ?? null);
  return (
    LOCAL_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    SECRET.test(key) ||
    text.includes("keychain:") ||
    LOCAL_PATH.test(text)
  );
}

/** A project row without its folders, which belong to this Mac; the owner adds them again. */
function portable(kind: BundleKind, row: Row): Row {
  const clean = withoutSecrets(row);
  return kind === "project" ? { ...clean, roots: [] } : clean;
}

/** What a bundle holds, read from this daemon. */
export function bundleData(input: {
  snapshot: Record<string, unknown[] | undefined>;
  skills: { name: string; files: SkillBundle["files"] }[];
  connections: string[];
  at?: string;
}): BundleData {
  const entities: Partial<Record<BundleKind, Row[]>> = {};
  const counts: Record<string, number> = {};
  for (const kind of BUNDLE_KINDS) {
    const rows = (input.snapshot[kind] ?? []) as Row[];
    entities[kind] = rows.map((row) =>
      portable(kind, kind === "routine" ? { ...row, paused: true } : row),
    );
    counts[kind] = rows.length;
  }
  const settings = ((input.snapshot.settings ?? []) as { key: string; value: unknown }[])
    .filter((row) => !localSetting(row.key, row.value))
    .map((row) => ({ key: row.key, value: withoutSecrets(row.value) }));
  const used = new Set((entities.agent ?? []).map((row) => row.definitionId));
  const definitions = ((input.snapshot.agentDefinition ?? []) as Row[])
    .filter((row) => used.has(row.id))
    .map((row) => ({ id: row.id, displayName: String(row.displayName ?? row.id) }));
  counts.settings = settings.length;
  counts.skills = input.skills.length;
  return {
    manifest: {
      format: BUNDLE_FORMAT,
      exportedAt: input.at ?? new Date().toISOString(),
      counts,
      connections: [...new Set(input.connections)].sort(),
    },
    entities,
    definitions,
    settings,
    skills: input.skills,
  };
}

const json = (value: unknown) => strToU8(`${JSON.stringify(value, null, 2)}\n`);

/** The bundle as ZIP bytes. */
export function zipBundle(data: BundleData): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "manifest.json": json(data.manifest),
    "settings.json": json(data.settings),
    "skills.json": json(data.skills),
    "definitions.json": json(data.definitions),
  };
  for (const kind of BUNDLE_KINDS) files[`entities/${kind}.json`] = json(data.entities[kind] ?? []);
  return zipSync(files, { level: 6 });
}

/** Reads ZIP bytes back into a bundle, or throws `invalid_bundle`. */
export function unzipBundle(bytes: Uint8Array): BundleData {
  if (bytes.byteLength > BUNDLE_MAX_BYTES) throw new Error("invalid_bundle: too large");
  let files: Record<string, Uint8Array>;
  let unpacked = 0;
  try {
    files = unzipSync(bytes, {
      // A ZIP that unpacks to more than the cap is refused before it is unpacked.
      filter: (file) => {
        unpacked += file.originalSize;
        if (unpacked > BUNDLE_MAX_BYTES) throw new Error("too_large");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "too_large")
      throw new Error("invalid_bundle: too large");
    throw new Error("invalid_bundle: not a Zoltbot export");
  }
  const read = (name: string): unknown => {
    const file = files[name];
    if (!file) throw new Error(`invalid_bundle: missing ${name}`);
    return JSON.parse(strFromU8(file));
  };
  const manifest = read("manifest.json") as BundleData["manifest"];
  if (manifest?.format !== BUNDLE_FORMAT) throw new Error("invalid_bundle: unknown format");
  const entities: Partial<Record<BundleKind, Row[]>> = {};
  for (const kind of BUNDLE_KINDS) {
    const rows = files[`entities/${kind}.json`] ? read(`entities/${kind}.json`) : [];
    if (!Array.isArray(rows) || rows.some((row) => typeof row?.id !== "string"))
      throw new Error(`invalid_bundle: ${kind}`);
    // A hand-edited bundle can't carry a secret in either.
    entities[kind] = (rows as Row[]).map((row) => portable(kind, row));
  }
  const settings = read("settings.json");
  const skills = read("skills.json");
  const definitions = files["definitions.json"] ? read("definitions.json") : [];
  if (!Array.isArray(definitions)) throw new Error("invalid_bundle");
  if (!Array.isArray(settings) || !Array.isArray(skills)) throw new Error("invalid_bundle");
  return {
    manifest,
    entities,
    definitions: (definitions as Row[])
      .filter((row) => typeof row?.id === "string")
      .map((row) => ({ id: row.id, displayName: String(row.displayName ?? row.id) })),
    settings: (settings as BundleData["settings"]).filter(
      (row) => typeof row?.key === "string" && !localSetting(row.key, row.value),
    ),
    skills: (skills as BundleData["skills"]).filter(
      (skill) => typeof skill?.name === "string" && Array.isArray(skill.files),
    ),
  };
}

export interface BundleItem {
  id: string;
  kind: BundleKind | "settings" | "skill";
  name: string;
  action: "add" | "replace";
}

function rowName(row: Row): string {
  for (const key of ["name", "title", "displayName", "key"])
    if (typeof row[key] === "string" && row[key]) return row[key] as string;
  return row.id;
}

/** What importing would add or replace here. */
export function bundlePreview(
  data: BundleData,
  snapshot: Record<string, unknown[] | undefined>,
  skillNames: readonly string[],
): { agents: number; items: BundleItem[]; tools: string[] } {
  const items: BundleItem[] = [];
  const blocked = missingTools(data, snapshot);
  for (const kind of BUNDLE_KINDS) {
    const here = new Set(((snapshot[kind] ?? []) as Row[]).map((row) => row.id));
    for (const row of importable(data, kind, blocked))
      items.push({
        id: `${kind}:${row.id}`,
        kind,
        name: rowName(row),
        action: here.has(row.id) ? "replace" : "add",
      });
  }
  const settingsHere = new Set(
    ((snapshot.settings ?? []) as { key: string }[]).map((row) => row.key),
  );
  for (const row of data.settings)
    items.push({
      id: `settings:${row.key}`,
      kind: "settings",
      name: row.key,
      action: settingsHere.has(row.key) ? "replace" : "add",
    });
  const skillsHere = new Set(skillNames);
  for (const skill of data.skills)
    items.push({
      id: `skill:${skill.name}`,
      kind: "skill",
      name: skill.name,
      action: skillsHere.has(skill.name) ? "replace" : "add",
    });
  return {
    agents: importable(data, "agent", blocked).length,
    items,
    tools: data.definitions.filter((tool) => blocked.has(tool.id)).map((tool) => tool.displayName),
  };
}

/** The coding tools the bundle's agents use that aren't set up here. */
function missingTools(
  data: BundleData,
  snapshot: Record<string, unknown[] | undefined>,
): Set<string> {
  const here = new Set(((snapshot.agentDefinition ?? []) as Row[]).map((row) => row.id));
  return new Set(
    (data.entities.agent ?? [])
      .map((row) => String(row.definitionId))
      .filter((id) => !here.has(id)),
  );
}

/** A kind's rows, without agents whose coding tool isn't set up here: they'd have nothing to run. */
function importable(data: BundleData, kind: BundleKind, blocked: ReadonlySet<string>): Row[] {
  const rows = data.entities[kind] ?? [];
  return kind === "agent" ? rows.filter((row) => !blocked.has(String(row.definitionId))) : rows;
}

/**
 * Whether `row` should replace `local`. A newer local knowledge item stays, so its history keeps
 * every revision; a routine keeps whether it was paused here.
 */
function merged(kind: BundleKind, row: Row, local: Row | undefined): Row | null {
  if (!local) return row;
  if (kind === "knowledge" && Number(local.revision ?? 0) >= Number(row.revision ?? 0)) return null;
  if (kind === "routine") return { ...row, paused: local.paused };
  if (kind === "project") return { ...row, roots: local.roots };
  return row;
}

/** The events that write the selected rows. Skills go through the skills library instead. */
export function bundleEvents(
  data: BundleData,
  selected: ReadonlySet<string>,
  snapshot: Record<string, unknown[] | undefined>,
  at: string,
  /** Makes every import's event ids unique. */
  batch: string = randomUUID(),
): Omit<DomainEvent, "commandId">[] {
  const events: Omit<DomainEvent, "commandId">[] = [];
  const id = () => `bundle:${batch}:${events.length}`;
  const blocked = missingTools(data, snapshot);
  for (const kind of BUNDLE_KINDS) {
    const here = new Map(((snapshot[kind] ?? []) as Row[]).map((row) => [row.id, row]));
    for (const row of importable(data, kind, blocked)) {
      if (!selected.has(`${kind}:${row.id}`)) continue;
      const payload = merged(kind, row, here.get(row.id));
      if (!payload) continue;
      events.push({
        eventId: id(),
        aggregateType: kind,
        aggregateId: row.id,
        type: `${kind}.${here.has(row.id) ? "updated" : "created"}`,
        occurredAt: at,
        payload,
      } as Omit<DomainEvent, "commandId">);
    }
  }
  for (const row of data.settings) {
    if (!selected.has(`settings:${row.key}`)) continue;
    events.push({
      eventId: id(),
      aggregateType: "settings",
      aggregateId: row.key,
      type: "settings.created",
      occurredAt: at,
      payload: row,
    } as Omit<DomainEvent, "commandId">);
  }
  return events;
}

/** The daemon side: export.bundle, import.bundle, and import.apply for a bundle's preview. */
export function bundleApi(host: {
  snapshot: () => Record<string, unknown[] | undefined>;
  skills: {
    list: () => { name: string; files: SkillBundle["files"] }[];
    add: (skill: { name: string; files: SkillBundle["files"] }) => void;
    /** Throws when a skill would be refused, so nothing is written. */
    check: (skill: { name: string; files: SkillBundle["files"] }) => void;
  };
  connections: () => Promise<string[]> | string[];
  /** Writes the events in one command, with the skills added inside it. */
  write: (commandId: string, events: Omit<DomainEvent, "commandId">[], inside: () => void) => void;
}) {
  const previews = new Map<string, BundleData>();
  return async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "export.bundle") {
      const path = String(params.path ?? "");
      if (!path.startsWith("/") || !path.endsWith(".zip")) throw new Error("invalid_path");
      // Never write through a link to somewhere else.
      if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error("invalid_path");
      const data = bundleData({
        snapshot: host.snapshot(),
        skills: host.skills.list(),
        connections: await host.connections(),
      });
      await writeFile(path, zipBundle(data), { mode: 0o600 });
      return { path, counts: data.manifest.counts };
    }
    if (method === "import.bundle") {
      const path = String(params.path ?? "");
      if (!path.startsWith("/")) throw new Error("invalid_path");
      const file = await lstat(path);
      if (!file.isFile() || file.size > BUNDLE_MAX_BYTES)
        throw new Error("invalid_bundle: too large");
      const data = unzipBundle(new Uint8Array(await readFile(path)));
      const previewId = `bundle:${randomUUID()}`;
      previews.clear();
      previews.set(previewId, data);
      const preview = bundlePreview(
        data,
        host.snapshot(),
        host.skills.list().map((skill) => skill.name),
      );
      return { previewId, ...preview, connections: data.manifest.connections };
    }
    if (method === "import.apply" && String(params.previewId).startsWith("bundle:")) {
      if (params.consent !== true) throw new Error("import_consent_required");
      const previewId = String(params.previewId);
      const data = previews.get(previewId);
      if (!data) throw new Error("import_preview_expired");
      const selected = new Set((params.selected as string[] | undefined) ?? []);
      const skills = data.skills.filter((skill) => selected.has(`skill:${skill.name}`));
      // Check every skill first, so a refused one doesn't leave half an import behind.
      for (const skill of skills) host.skills.check(skill);
      previews.delete(previewId);
      host.write(
        `import:${previewId}`,
        bundleEvents(data, selected, host.snapshot(), new Date().toISOString()),
        () => {
          for (const skill of skills) host.skills.add(skill);
        },
      );
      return { ok: true };
    }
    return undefined;
  };
}

/** The skills library as a bundle sees it: current revisions out, new or newer revisions in. */
export function bundleSkills(database: ConstructorParameters<typeof SkillsLibrary>[0]) {
  const library = new SkillsLibrary(database);
  return {
    check: (skill: { name: string; files: SkillBundle["files"] }) => void parseSkill(skill.files),
    list: () =>
      library.list().map((entry) => {
        const { bundle } = library.revision(entry.id, entry.current_revision);
        return { name: entry.name, files: bundle.files };
      }),
    add: (skill: { name: string; files: SkillBundle["files"] }) => {
      const existing = library.list().find((entry) => entry.name === skill.name);
      if (!existing) return void library.add(skill as SkillBundle, "import");
      library.save(existing.id, existing.current_revision, skill as SkillBundle);
    },
  };
}
