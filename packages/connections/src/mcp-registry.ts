// I6: search the official MCP registry. The registry checks who owns a server's namespace when it
// is published (a GitHub account for io.github.<owner>/…, DNS or HTTP for a domain), so the
// publisher shown here is the verified one. Results are cached for an hour.
import { requestJson } from "./network.js";

export const MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
const CACHE_MS = 60 * 60 * 1000;
const MAX_CACHE = 200;
const LIMIT = 30;
const OFFICIAL = "io.modelcontextprotocol.registry/official";

type Json = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) => (Array.isArray(value) ? (value as Json[]) : []);

export interface RegistryInput {
  name: string;
  required: boolean;
  secret: boolean;
  description: string;
}

export type RegistryInstall =
  | { kind: "remote"; url: string; headers: RegistryInput[] }
  | {
      kind: "package";
      registryType: "npm" | "pypi";
      /** The command exactly as it runs: `npx -y pkg@1.2.3` or `uvx pkg==1.2.3`. */
      command: string[];
      env: RegistryInput[];
    }
  /** Only other kinds (Docker images, servers that need URL variables); shown, not addable. */
  | { kind: "unsupported" };

export interface RegistryServer {
  /** The registry name, such as `io.github.owner/server`; stable across versions. */
  id: string;
  title: string;
  description: string;
  version: string;
  /** Whose ownership the registry checked: a domain or a GitHub account. */
  publisher: { kind: "domain" | "github"; name: string };
  repository?: string;
  install: RegistryInstall;
}

const inputs = (value: unknown): RegistryInput[] =>
  list(value)
    .filter((row) => text(row.name))
    .map((row) => ({
      name: text(row.name),
      required: row.isRequired === true,
      secret: row.isSecret === true,
      description: text(row.description).slice(0, 200),
    }));

/** `io.github.acme/x` is GitHub user acme; `com.example/x` is example.com. */
export function publisherOf(id: string): RegistryServer["publisher"] {
  const namespace = id.split("/")[0] ?? "";
  if (namespace.startsWith("io.github."))
    return { kind: "github", name: namespace.slice("io.github.".length) };
  return { kind: "domain", name: namespace.split(".").reverse().join(".") };
}

const SAFE_PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-zA-Z0-9][\w.-]*$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

function installOf(server: Json): RegistryInstall {
  // A remote server is simplest: nothing runs on the Mac.
  for (const remote of list(server.remotes)) {
    const url = text(remote.url);
    if (!["streamable-http", "sse"].includes(text(remote.type))) continue;
    if (!url.startsWith("https://") || /[{}]/.test(url)) continue;
    // A saved connection URL carries no query, fragment or credentials.
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    if (!parsed || parsed.search || parsed.hash || parsed.username || parsed.password) continue;
    return { kind: "remote", url, headers: inputs(remote.headers) };
  }
  for (const pkg of list(server.packages)) {
    const type = text(pkg.registryType);
    const id = text(pkg.identifier);
    const version = text(pkg.version);
    if (text((pkg.transport as Json | undefined)?.type) !== "stdio") continue;
    // Arguments the owner would have to fill in aren't supported yet.
    if (list(pkg.packageArguments).some((arg) => arg.isRequired === true && !text(arg.value)))
      continue;
    // An unpinned package would run whatever is newest on every launch, not what was approved.
    if (!SAFE_PACKAGE.test(id) || !SAFE_VERSION.test(version)) continue;
    if (type === "npm")
      return {
        kind: "package",
        registryType: "npm",
        command: ["npx", "-y", `${id}@${version}`],
        env: inputs(pkg.environmentVariables),
      };
    if (type === "pypi")
      return {
        kind: "package",
        registryType: "pypi",
        command: ["uvx", `${id}==${version}`],
        env: inputs(pkg.environmentVariables),
      };
  }
  return { kind: "unsupported" };
}

/** Reads one registry item, in the wrapped `{server, _meta}` shape or the older flat one. */
export function registryServer(item: Json): RegistryServer | undefined {
  const server = (item.server ?? item) as Json;
  const meta = ((item._meta ?? server._meta) as Json | undefined)?.[OFFICIAL] as Json | undefined;
  if (meta && (text(meta.status) !== "active" || meta.isLatest === false)) return undefined;
  const id = text(server.name);
  if (id.length > 200 || !/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(id)) return undefined;
  const repository = text((server.repository as Json | undefined)?.url);
  return {
    id,
    title: (text(server.title) || id.split("/")[1] || id).slice(0, 100),
    description: text(server.description).slice(0, 300),
    version: text(server.version).slice(0, 50),
    publisher: publisherOf(id),
    ...(repository.startsWith("https://") ? { repository } : {}),
    install: installOf(server),
  };
}

export interface RegistryClientOptions {
  baseUrl?: string;
  /** Fetches JSON; by default through the pinned-DNS request, to the registry's origin only. */
  get?: (url: string) => Promise<unknown>;
  now?: () => number;
}

export function mcpRegistryClient(options: RegistryClientOptions = {}) {
  const base = options.baseUrl ?? MCP_REGISTRY_URL;
  const get =
    options.get ??
    ((url: string) =>
      requestJson(url, { origins: [new URL(base).origin] }, undefined, {
        signal: AbortSignal.timeout(10_000),
        maxBytes: 2_000_000,
      }));
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; servers: RegistryServer[] }>();

  async function search(query: string): Promise<RegistryServer[]> {
    const key = query.trim().toLowerCase().slice(0, 100);
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.servers;
    const url = new URL("/v0/servers", base);
    // The registry needs at least three characters to search; fewer lists what's newest.
    if (key.length >= 3) url.searchParams.set("search", key);
    url.searchParams.set("limit", String(LIMIT));
    url.searchParams.set("version", "latest");
    let body: Json;
    try {
      body = ((await get(url.toString())) ?? {}) as Json;
    } catch {
      throw new Error("registry_unreachable");
    }
    const seen = new Set<string>();
    const servers = list(body.servers)
      .map(registryServer)
      .filter((server): server is RegistryServer => {
        if (!server || seen.has(server.id)) return false;
        seen.add(server.id);
        return true;
      });
    cache.set(key, { at: now(), servers });
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
    return servers;
  }

  /** One server by id, from the newest cached search that has it. */
  async function find(id: string): Promise<RegistryServer | undefined> {
    let newest: { at: number; server: RegistryServer } | undefined;
    for (const entry of cache.values()) {
      const server = entry.servers.find((row) => row.id === id);
      if (server && now() - entry.at < CACHE_MS && (!newest || entry.at > newest.at))
        newest = { at: entry.at, server };
    }
    return newest?.server ?? (await search(id)).find((row) => row.id === id);
  }

  return { search, find };
}
