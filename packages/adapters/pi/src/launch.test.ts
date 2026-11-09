import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { piLaunch } from "./launch.js";

const definition: AgentDefinition = {
  id: "pi",
  displayName: "Pi",
  adapter: "pi",
  binaryNames: [],
  versionCommand: [],
  launch: { command: "pi", args: [], env: {} },
  testedVersions: "1.4.0",
  defaults: { permissionProfile: "read_only" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
const options = {
  identity: { agentId: "profile", threadId: "thread" },
  mode: "new" as const,
  cwd: "/work",
  permissionProfile: "read_only" as const,
  hostMcp: { url: "http://127.0.0.1:1/mcp", token: "private" },
};
it("loads only the bundled gate and native MCP extension with persistent session identity", () => {
  const launch = piLaunch(
    definition,
    { ...options, model: "deepseek:model", effort: "medium" },
    { extension: "/bundle/gate.ts", config: "/private/config.json" },
    "native",
  );
  expect(launch.args).toEqual(
    expect.arrayContaining([
      "--no-extensions",
      "/bundle/gate.ts",
      "builtin:mcp",
      "--session-id",
      "native",
      "deepseek",
      "model",
      "medium",
    ]),
  );
  expect(launch.args).not.toContain("private");
  expect(launch.env.ZOLTBOT_PI_CONFIG).toBe("/private/config.json");
});
it("rejects launch arguments that bypass the gate or change session ownership", () => {
  for (const arg of [
    "--no-extensions",
    "--extension=unsafe",
    "--no-mcp",
    "--no-session",
    "--session-id",
  ])
    expect(() =>
      piLaunch(
        { ...definition, launch: { ...definition.launch, args: [arg] } },
        options,
        { extension: "e", config: "c" },
        "native",
      ),
    ).toThrow("conflicting_launch_flags");
});
