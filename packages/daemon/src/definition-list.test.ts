import { type AgentDefinition, methodCatalog, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { listDefinitions } from "./definition-list.js";

const definition: AgentDefinition = {
  id: "a",
  displayName: "Sample",
  adapter: "acp",
  binaryNames: ["sample"],
  versionCommand: ["--version"],
  launch: {
    command: "sample",
    args: ["acp", "synthetic-private-argument"],
    env: { API_KEY: "synthetic-private-key" },
  },
  auth: { apiKeyEnv: "API_KEY", statusCommand: ["status"] },
  testedVersions: "1.0.0",
  defaults: { permissionProfile: "workspace_write" },
  staticCapabilities: {},
  nativeSessionRoots: [],
  experimental: false,
};
it("returns a catalog conforming page with private configuration hidden and source data unchanged", () => {
  const result = listDefinitions([definition], {});
  expect(parse(methodCatalog["agentDefinition.list"].result, result)).toEqual(result);
  expect(result.items[0]).toMatchObject({ id: "a", auth: { apiKeyEnv: "API_KEY" } });
  expect(result.items[0]?.launch.args).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain("synthetic-private-");
  expect(definition.launch.env.API_KEY).toBe("synthetic-private-key");
  expect(definition.launch.args[1]).toBe("synthetic-private-argument");
});
it("pages deterministically and rejects invalid limits and stale definition cursors", () => {
  const definitions = [{ ...definition, id: "b" }, definition];
  const first = listDefinitions(definitions, { limit: 1 });
  expect(first.items.map((row) => row.id)).toEqual(["a"]);
  const second = listDefinitions(definitions, { limit: 1, cursor: first.cursor });
  expect(second.items.map((row) => row.id)).toEqual(["b"]);
  expect(second.cursor).toBeUndefined();
  expect(() =>
    listDefinitions([{ ...definition, displayName: "Changed" }], { cursor: first.cursor }),
  ).toThrow("definition_cursor_stale");
  expect(() => listDefinitions(definitions, { limit: 0 })).toThrow("invalid_definition_page_size");
  expect(() => listDefinitions(definitions, { cursor: "bad" })).toThrow("definition_cursor_stale");
});

it("keeps opaque references and removes URL credentials, queries, and executable install text", () => {
  const reference = "keychain:zoltbot:11111111-1111-4111-8111-111111111111";
  const page = listDefinitions(
    [
      {
        ...definition,
        launch: { ...definition.launch, env: { API_KEY: reference } },
        install: {
          docsUrl:
            "https://user:synthetic-private-password@example.com/docs?token=synthetic-private-query#private",
          command: "synthetic-private-install",
        },
      },
    ],
    {},
  );
  expect(page.items[0]?.launch.env.API_KEY).toBe(reference);
  expect(page.items[0]?.install?.docsUrl).toBe("https://example.com/docs");
  expect(JSON.stringify(page)).not.toContain("synthetic-private-");
});
