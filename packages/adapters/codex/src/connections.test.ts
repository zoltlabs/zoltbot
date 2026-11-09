import type { OpenOptions } from "@zoltbot/adapters-sdk";
import { expect, it } from "vitest";
import { codexConnections } from "./connections.js";

it("disables inherited MCP entries without dropping host tools or selected servers", () => {
  const options = {
    identity: { agentId: "agent", threadId: "thread" },
    mode: "new",
    cwd: "/work",
    permissionProfile: "read_only",
    hostMcp: { url: "http://127.0.0.1/mcp", token: "host-secret" },
    connections: [
      {
        kind: "https",
        name: "selected",
        url: "https://selected.example/mcp",
        headers: { Authorization: "Bearer private" },
      },
    ],
  } as OpenOptions;
  expect(
    codexConnections(
      { config: { mcp_servers: { unrelated: { url: "https://private.example" } } } },
      options,
    ),
  ).toEqual({
    unrelated: { enabled: false },
    zoltbot_connection_selected: {
      url: "https://selected.example/mcp",
      http_headers: { Authorization: "Bearer private" },
      required: true,
      enabled: true,
    },
    zoltbot: {
      url: "http://127.0.0.1/mcp",
      http_headers: { Authorization: "Bearer host-secret" },
      required: true,
      enabled: true,
    },
  });
});

it("refuses inherited host or managed aliases instead of merging private native fields", () => {
  const options = {
    identity: { agentId: "agent", threadId: "thread" },
    mode: "new",
    cwd: "/work",
    permissionProfile: "read_only",
    hostMcp: { url: "http://127.0.0.1/mcp", token: "host" },
    connections: [{ kind: "https", name: "app", url: "https://app.example", headers: {} }],
  } as OpenOptions;
  expect(() =>
    codexConnections({ config: { mcp_servers: { zoltbot: { command: "unapproved" } } } }, options),
  ).toThrow("host_mcp_name_conflict");
  expect(() =>
    codexConnections(
      { config: { mcp_servers: { zoltbot_connection_app: { env: { PRIVATE: "secret" } } } } },
      options,
    ),
  ).toThrow("connection_native_name_conflict");
});

it("leaves inherited MCP entries on when the session keeps the person's own tools", () => {
  const options = {
    identity: { agentId: "agent", threadId: "thread" },
    mode: "new",
    cwd: "/work",
    permissionProfile: "read_only",
    hostMcp: { url: "http://127.0.0.1/mcp", token: "host" },
    ownTools: true,
  } as OpenOptions;
  const servers = codexConnections(
    { config: { mcp_servers: { search: { url: "https://search.example" } } } },
    options,
  );
  expect(servers).not.toHaveProperty("search");
  expect(servers).toHaveProperty("zoltbot");
  expect(
    codexConnections(
      { config: { mcp_servers: { search: { url: "https://search.example" }, mail: {} } } },
      { ...options, ownToolsOff: ["mail", "missing"] },
    ),
  ).toMatchObject({ mail: { enabled: false } });
});
