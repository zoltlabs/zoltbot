import { AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { piDefaultDefinition, piDefinitions } from "./definitions.js";
import { piLaunch } from "./launch.js";

it("loads credential references without embedding keys or guessed model identifiers", () => {
  expect(piDefinitions.map((d) => d.id)).toEqual(["pi:deepseek", "pi:openrouter"]);
  for (const definition of piDefinitions) {
    expect(parse(AgentDefinitionSchema, definition)).toEqual(definition);
    expect(definition.auth?.apiKeyEnv).toBe(
      definition.flavor === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY",
    );
    expect(definition.launch.env).toEqual({});
    const launch = piLaunch(
      definition,
      {
        identity: { agentId: "profile", threadId: "thread" },
        mode: "new",
        cwd: "/work",
        permissionProfile: "read_only",
        hostMcp: { url: "http://127.0.0.1:1/mcp", token: "synthetic" },
      },
      { extension: "e", config: "c" },
      "native",
    );
    expect(
      launch.args.slice(launch.args.indexOf("--provider"), launch.args.indexOf("--provider") + 2),
    ).toEqual(["--provider", definition.flavor]);
    expect(launch.args).not.toContain("--model");
  }
});

it("does not switch a provider profile to another credential namespace", () => {
  const definition = piDefinitions[0];
  if (!definition) throw new Error("missing_definition");
  expect(() =>
    piLaunch(
      definition,
      {
        identity: { agentId: "profile", threadId: "thread" },
        mode: "new",
        model: "openrouter:other",
        cwd: "/work",
        permissionProfile: "read_only",
        hostMcp: { url: "http://127.0.0.1:1/mcp", token: "synthetic" },
      },
      { extension: "e", config: "c" },
      "native",
    ),
  ).toThrow("unsupported_model");
});

it("keeps the generic Pi definition on the native default provider", () => {
  expect(piDefaultDefinition.auth).toBeUndefined();
  const launch = piLaunch(
    piDefaultDefinition,
    {
      identity: { agentId: "profile", threadId: "thread" },
      mode: "new",
      cwd: "/work",
      permissionProfile: "read_only",
      hostMcp: { url: "http://127.0.0.1:1/mcp", token: "synthetic" },
    },
    { extension: "e", config: "c" },
    "native",
  );
  expect(launch.args).not.toContain("--provider");
  expect(launch.args).not.toContain("--model");
});
