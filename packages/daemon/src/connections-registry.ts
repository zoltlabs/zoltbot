// I6: apps from the official MCP registry. Search is a read; adding saves a connection turned
// off, like a catalog install. A package server runs on this Mac, so it's added only after the
// owner confirmed the exact command.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { LoginPath } from "@zoltbot/detect";
import {
  mcpRegistryClient,
  type RegistryInput,
  type RegistryServer,
} from "../../connections/src/mcp-registry.js";
import type { ConnectionRecord } from "../../connections/src/registry.js";

export interface RegistryItem {
  id: string;
  title: string;
  description: string;
  version: string;
  publisher: RegistryServer["publisher"];
  repository?: string;
  install: "remote" | "package" | "unsupported";
  /** The command a package server runs, as the owner sees it before adding. */
  runs?: string;
  /** Where a remote server lives, as the owner sees it before adding. */
  url?: string;
  /** Settings it can't start without (keys, headers); not addable until they're supported. */
  needs: string[];
}

const required = (inputs: RegistryInput[]) =>
  inputs.filter((input) => input.required).map((input) => input.name.slice(0, 100));

export function registryItem(server: RegistryServer): RegistryItem {
  const { install } = server;
  return {
    id: server.id,
    title: server.title,
    description: server.description,
    version: server.version,
    publisher: server.publisher,
    ...(server.repository ? { repository: server.repository } : {}),
    install: install.kind,
    ...(install.kind === "package" ? { runs: install.command.join(" ") } : {}),
    ...(install.kind === "remote" ? { url: install.url } : {}),
    needs: (install.kind === "remote"
      ? required(install.headers)
      : install.kind === "package"
        ? required(install.env)
        : []
    ).slice(0, 50),
  };
}

export const addable = (item: RegistryItem) => item.install !== "unsupported" && !item.needs.length;

/** `io.github.acme/issues-mcp` → `issues-mcp_1a2b3c4d`; the suffix keeps two installs apart. */
export function registryConnectionName(registryId: string, id: string) {
  const base = (registryId.split("/")[1] ?? "app")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^[^a-zA-Z]+/, "")
    .slice(0, 40);
  return `${base || "app"}_${id.replace(/-/g, "").slice(0, 8)}`;
}

/** A stable id from a stable key, so a retried approval saves the same connection. */
export function stableConnectionId(key: string) {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type RegistryTransport = ConnectionRecord["transport"];

export function registryConnections(
  options: {
    client?: ReturnType<typeof mcpRegistryClient>;
    /** Directories to look for npx and uvx in; by default the login shell's PATH. */
    paths?: () => Promise<string[]>;
  } = {},
) {
  const client = options.client ?? mcpRegistryClient();
  const loginPath = new LoginPath();
  const paths =
    options.paths ??
    (() =>
      loginPath.resolve(process.env.SHELL ?? "/bin/zsh", {
        cwd: homedir(),
        inherited: { HOME: homedir(), PATH: process.env.PATH },
      }));

  async function resolve(name: string) {
    for (const directory of (await paths()).filter((entry) => path.isAbsolute(entry))) {
      const file = path.join(directory, name);
      try {
        await access(file, constants.X_OK);
        return file;
      } catch {}
    }
    throw new Error(name === "npx" ? "registry_needs_node" : "registry_needs_uv");
  }

  /** `expected` is what the owner saw; a server that changed since is refused, not saved. */
  async function prepare(
    registryId: string,
    expected?: { version: string; runs?: string; url?: string },
  ) {
    const server = await client.find(registryId);
    if (!server) throw new Error("registry_server_not_found");
    const item = registryItem(server);
    if (
      expected &&
      (expected.version !== item.version ||
        (expected.runs ?? "") !== (item.runs ?? "") ||
        (expected.url ?? "") !== (item.url ?? ""))
    )
      throw new Error("registry_server_changed");
    if (item.install === "unsupported") throw new Error("registry_server_unsupported");
    if (item.needs.length) throw new Error("registry_server_needs_settings");
    const { install } = server;
    let transport: RegistryTransport;
    if (install.kind === "remote") transport = { kind: "https", url: install.url };
    else if (install.kind === "package") {
      const [program = "", ...args] = install.command;
      transport = { kind: "stdio", command: await resolve(program), args };
    } else throw new Error("registry_server_unsupported");
    return { item, transport };
  }

  return {
    async search(query: string) {
      return (await client.search(query.slice(0, 100))).map(registryItem);
    },
    prepare,
    /** The connection as saved: off, for no agent, unless an approval turns it on. */
    record(input: {
      id: string;
      projectId: string;
      item: RegistryItem;
      transport: RegistryTransport;
      executionApproved: boolean;
      agentId?: string;
    }): ConnectionRecord {
      const stdio = input.transport.kind === "stdio";
      if (stdio && !input.executionApproved)
        throw new Error("connection_execution_confirmation_required");
      return {
        id: input.id,
        name: registryConnectionName(input.item.id, input.id),
        projectId: input.projectId,
        version: 1,
        source: `registry:${input.item.id}@${input.item.version}`.slice(0, 300),
        transport: input.transport,
        schemaTokens: { value: 512, source: "estimated" },
        ...(stdio ? { executionApproved: true } : {}),
        enabled: Boolean(input.agentId),
        profileIds: input.agentId ? [input.agentId] : [],
        credentialStatus: "not_required",
        health: "not_checked",
      };
    },
  };
}
export type RegistryConnections = ReturnType<typeof registryConnections>;

let shared: RegistryConnections | undefined;
/** One client per daemon, so the Settings page and agents share the search cache. */
export const sharedRegistryConnections = () => (shared ??= registryConnections());
