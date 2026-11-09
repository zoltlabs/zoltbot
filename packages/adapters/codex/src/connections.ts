import type { OpenOptions } from "@zoltbot/adapters-sdk";
import { object } from "./schema.js";

/**
 * Explicitly disable inherited MCP entries before attaching this session's selected servers, unless
 * the session keeps the person's own tools.
 */
export function codexConnections(configuration: unknown, options: OpenOptions) {
  const inherited = object(object(configuration).config).mcp_servers;
  const inheritedServers = object(inherited ?? {});
  if (Object.hasOwn(inheritedServers, "zoltbot")) throw new Error("host_mcp_name_conflict");
  for (const connection of options.connections ?? [])
    if (Object.hasOwn(inheritedServers, `zoltbot_connection_${connection.name}`))
      throw new Error("connection_native_name_conflict");
  const disabled = options.ownTools
    ? Object.fromEntries(
        (options.ownToolsOff ?? [])
          .filter((name) => Object.hasOwn(inheritedServers, name))
          .map((name) => [name, { enabled: false }]),
      )
    : Object.fromEntries(
        Object.keys(object(inherited ?? {})).map((name) => [name, { enabled: false }]),
      );
  return {
    ...disabled,
    ...Object.fromEntries(
      (options.connections ?? []).map((connection) => [
        `zoltbot_connection_${connection.name}`,
        connection.kind === "https"
          ? { url: connection.url, http_headers: connection.headers, required: true, enabled: true }
          : { command: connection.command, args: connection.args, required: true, enabled: true },
      ]),
    ),
    zoltbot: {
      url: options.hostMcp.url,
      http_headers: { Authorization: `Bearer ${options.hostMcp.token}` },
      required: true,
      enabled: true,
    },
  };
}
