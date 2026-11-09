import { type ImportItem, importSourceOptions } from "@zoltbot/protocol";
import { label, record } from "./doctor-data.js";

export type AgentRow = {
  id: string;
  name: string;
  path?: string;
  version?: string;
  support?: string;
  login: string;
  plan?: string;
  broken: number;
  ready: boolean;
};
export function agentRows(checks: Record<string, unknown>[]): AgentRow[] {
  return checks
    .filter((row) => row.kind === "agent")
    .map((row) => {
      const install = record(row.install),
        chosen = record(install.selected),
        login = record(row.login);
      const path = typeof chosen.path === "string" ? chosen.path : undefined;
      const state = label(login.state, "unknown");
      return {
        id: label(row.definitionId),
        name: label(row.displayName),
        ...(path ? { path } : {}),
        ...(typeof chosen.version === "string" ? { version: chosen.version } : {}),
        ...(typeof chosen.support === "string" ? { support: chosen.support } : {}),
        login: state,
        ...(typeof login.plan === "string" ? { plan: login.plan } : {}),
        broken: Array.isArray(install.candidates)
          ? install.candidates.filter((candidate) => record(candidate).state === "broken").length
          : 0,
        ready: Boolean(path) && !row.unavailableReason && state !== "signed_out",
      };
    })
    .sort((a, b) => Number(Boolean(b.path)) - Number(Boolean(a.path)));
}
/** Every agent that is installed and signed in starts checked. */
export const defaultAgents = (rows: AgentRow[]) =>
  new Set(rows.filter((row) => row.ready && row.login !== "unknown").map((row) => row.id));

const preferred = ["claude", "codex", "antigravity"];
/** The first chat goes to Claude Code, then Codex, then Antigravity, otherwise any connected agent. */
export function firstChatAgent(ids: readonly string[], random = Math.random): string | undefined {
  return preferred.find((id) => ids.includes(id)) ?? ids[Math.floor(random() * ids.length)];
}

/** Sources Zoltbot can read history from, limited to the agents being connected. */
export const historySources = (ids: Iterable<string>) => {
  const chosen = new Set(ids);
  return importSourceOptions.map((option) => option.id).filter((id) => chosen.has(id));
};

export type SessionGroup = {
  key: string;
  name: string;
  repoRoot?: string;
  github: boolean;
  sessions: ImportItem[];
  latest: number;
};
export const outsideRepository = "outside";
export const rangeDays = { all: undefined, 90: 90, 30: 30 } as const;
export type Range = keyof typeof rangeDays;

/** Group sessions by GitHub name, then repository folder; brief sessions are counted, not listed. */
export function sessionGroups(items: readonly ImportItem[], range: Range, now = Date.now()) {
  const days = rangeDays[range];
  const since = days === undefined ? 0 : now - days * 86400000;
  const groups = new Map<string, SessionGroup>();
  let brief = 0;
  for (const item of items) {
    if (item.kind !== "session" || (item.modifiedAt ?? 0) < since) continue;
    if (item.brief) {
      brief++;
      continue;
    }
    const key = item.remote ?? item.repoRoot ?? outsideRepository;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name:
          item.remote ??
          (item.repoRoot ? baseName(item.repoRoot) : "Sessions outside a repository"),
        ...(item.repoRoot ? { repoRoot: item.repoRoot } : {}),
        github: Boolean(item.remote),
        sessions: [],
        latest: 0,
      };
      groups.set(key, group);
    }
    group.sessions.push(item);
    group.latest = Math.max(group.latest, item.modifiedAt ?? 0);
  }
  const list = [...groups.values()];
  for (const group of list)
    group.sessions.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  list.sort(
    (a, b) =>
      Number(a.key === outsideRepository) - Number(b.key === outsideRepository) ||
      b.latest - a.latest,
  );
  return { groups: list, brief };
}
const baseName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

/**
 * The import selection: chosen sessions and MCP servers, plus the project for each repository a
 * chosen session belongs to. Repositories without chosen sessions do not become projects.
 */
export function importSelection(
  items: readonly ImportItem[],
  sessions: ReadonlySet<string>,
  servers: ReadonlySet<string>,
): string[] {
  const roots = new Set(
    items.flatMap((item) => (sessions.has(item.id) && item.repoRoot ? [item.repoRoot] : [])),
  );
  const projects = new Map<string, string>();
  for (const item of items)
    if (item.kind === "project" && item.path) {
      const root = item.repoRoot ?? item.path;
      if (roots.has(root) && (!projects.has(root) || item.path === root))
        projects.set(root, item.id);
    }
  return [
    ...items
      .filter(
        (item) =>
          (item.kind === "session" && sessions.has(item.id)) ||
          (item.kind === "mcp" && servers.has(item.id)),
      )
      .map((item) => item.id),
    ...projects.values(),
  ].sort();
}

/** Same named servers from several tools appear once; each keeps its own import identity. */
export function serverRows(items: readonly ImportItem[]) {
  const rows = new Map<
    string,
    { name: string; ids: string[]; sources: string[]; secrets: string[] }
  >();
  for (const item of items) {
    if (item.kind !== "mcp" || item.scopePath) continue;
    const row = rows.get(item.name) ?? { name: item.name, ids: [], sources: [], secrets: [] };
    row.ids.push(item.id);
    if (!row.sources.includes(item.source)) row.sources.push(item.source);
    for (const name of Object.keys(record(item.configuration?.env)))
      if (!row.secrets.includes(name)) row.secrets.push(name);
    rows.set(item.name, row);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
/** Claude files and unindexed Codex rollouts are named by ID; transcripts are not read for a title. */
export const sessionTitle = (item: ImportItem) =>
  /^(rollout-[\w:.-]*)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    item.name,
  )
    ? "Untitled session"
    : item.name;
export const sourceName = (id: string) =>
  importSourceOptions.find((option) => option.id === id)?.label ?? id;
