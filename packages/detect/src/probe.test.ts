import { expect, it } from "vitest";
import { probeCommand } from "./probe.js";

it("builds a conservative definition from only a validated ACP initialize response", async () => {
  const result = await probeCommand("opencode acp", {
    initialize: async (argv) => {
      expect(argv).toEqual(["opencode", "acp"]);
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: "example", title: "Example", version: "1.0.0" },
        authMethods: [{ id: "oauth", name: "Sign in" }],
        _meta: { email: "private@example.com" },
      };
    },
  });
  expect(result.definition).toMatchObject({
    adapter: "acp",
    displayName: "Example",
    launch: { command: "opencode", args: ["acp"] },
    defaults: { permissionProfile: "workspace_write" },
  });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.definition?.auth).toBeUndefined();
  expect(result.definition?.staticCapabilities).toEqual({
    resume: true,
    images: false,
    hostTools: "none",
  });
});
it("records only handshake capabilities without claiming session or tool execution", async () => {
  const result = await probeCommand("agent acp", {
    initialize: async () => ({
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: true },
        mcpCapabilities: { http: true, sse: true },
      },
    }),
  });
  expect(result.definition?.staticCapabilities).toEqual({
    resume: false,
    images: true,
    hostTools: "mcp_http",
  });
});
it("rejects malformed protocols and never starts a process without a sandbox host", async () => {
  expect(await probeCommand("opencode acp")).toEqual({ error: "probe_sandbox_unavailable" });
  expect(
    await probeCommand("agent; other", {
      initialize: async () => {
        throw new Error("must not run");
      },
    }),
  ).toEqual({ error: "invalid_command" });
  expect(
    await probeCommand("agent acp", { initialize: async () => ({ protocolVersion: 99 }) }),
  ).toEqual({ error: "not_an_acp_agent" });
});
