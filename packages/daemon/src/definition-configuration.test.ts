import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { assertPublicDefinition } from "./definition-configuration.js";

const definition: AgentDefinition = {
  id: "sample",
  displayName: "Sample",
  adapter: "acp",
  binaryNames: [],
  versionCommand: [],
  launch: { command: "sample", args: ["acp"], env: {} },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
it.each([
  { ...definition, auth: { loginCommand: ["login", "--token", "synthetic-private-login"] } },
  { ...definition, auth: { statusCommand: ["status", "--api-key=synthetic-private-status"] } },
  { ...definition, launch: { ...definition.launch, env: { API_KEY: "synthetic-private-env" } } },
  {
    ...definition,
    launch: { ...definition.launch, args: ["--api-key", "synthetic-private-argument"] },
  },
  {
    ...definition,
    install: {
      docsUrl: "https://example.com",
      command: "curl https://example.com/install?token=synthetic-private-query",
    },
  },
])("refuses credential literals before public definition writes: %#", (value) => {
  expect(() => assertPublicDefinition(value)).toThrow("definition_private_configuration_required");
});
it("accepts public arguments and budgets but refuses a masked registry view as an editing payload", () => {
  expect(() =>
    assertPublicDefinition({
      ...definition,
      launch: { ...definition.launch, env: { MAX_TOKENS: "4096" } },
    }),
  ).not.toThrow();
  expect(() =>
    assertPublicDefinition({
      ...definition,
      launch: { ...definition.launch, args: ["[private argument]"] },
    }),
  ).toThrow("definition_view_not_editable");
});

it("accepts an opaque protected environment reference without accepting a credential literal", () => {
  expect(() =>
    assertPublicDefinition({
      ...definition,
      launch: {
        ...definition.launch,
        env: { API_KEY: "keychain:zoltbot:11111111-1111-4111-8111-111111111111" },
      },
    }),
  ).not.toThrow();
});
