import type { ConnectionDescriptor } from "./launch-manifest.js";
import type { NativeConnection } from "./materialize.js";
import { requestJson } from "./network.js";

/** Read-only MCP initialize. Never execute a tool as a health test. */
export async function connectionHealth(
  descriptor: ConnectionDescriptor,
  resolved: NativeConnection,
) {
  if (resolved.kind === "stdio")
    throw new Error("connection_local_test_requires_execution_approval");
  const response = await requestJson(
    resolved.url,
    {
      origins: [new URL(resolved.url).origin],
      ...(resolved.local && new URL(resolved.url).hostname === "127.0.0.1"
        ? { localOrigins: [new URL(resolved.url).origin] }
        : {}),
    },
    undefined,
    {
      mcpResponseId: "zoltbot-health",
      headers: { ...resolved.headers, accept: "application/json, text/event-stream" },
      json: {
        jsonrpc: "2.0",
        id: "zoltbot-health",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "zoltbot", version: "0.1.0" },
        },
      },
    },
  );
  if (response.id !== "zoltbot-health" || !response.result || response.error)
    throw new Error("connection_health_failed");
  return { id: descriptor.id, health: "healthy" as const, checkedAt: new Date().toISOString() };
}
