import type { AgentDefinition } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { Redactor } from "./logging.js";
import { resolveRuntimeCredentials } from "./runtime-credentials.js";

const reference = "keychain:zoltbot:11111111-1111-4111-8111-111111111111";
function definition(): AgentDefinition {
  return {
    id: "test",
    displayName: "Synthetic tool",
    adapter: "acp",
    binaryNames: [],
    versionCommand: [],
    launch: {
      command: "synthetic",
      args: [],
      env: { API_KEY: reference, SECOND_KEY: reference, MAX_TOKENS: "4096" },
    },
    auth: { apiKeyEnv: "API_KEY" },
    testedVersions: "1",
    defaults: { permissionProfile: "workspace_write" },
    staticCapabilities: {},
    nativeSessionRoots: [],
    experimental: false,
  };
}
it("resolves protected environment references once into ephemeral configuration and masks all native frames", async () => {
  const source = definition(),
    before = structuredClone(source),
    redactor = new Redactor();
  let reads = 0;
  const result = await resolveRuntimeCredentials(
    source,
    {
      async read(value) {
        expect(value).toBe(reference);
        reads++;
        return "synthetic-runtime-private-value";
      },
    },
    redactor,
  );
  expect(reads).toBe(1);
  expect(source).toEqual(before);
  expect(result.definition.launch.env).toEqual({
    API_KEY: "synthetic-runtime-private-value",
    SECOND_KEY: "synthetic-runtime-private-value",
    MAX_TOKENS: "4096",
  });
  expect(result.privateValues).toEqual(["synthetic-runtime-private-value"]);
  expect(redactor.hidesFrames).toBe(true);
  expect(redactor.text("echo synthetic-runtime-private-value")).toBe("echo [redacted]");
});
it("keeps public settings public and rejects literal, missing, malformed, and oversized credentials", async () => {
  const publicDefinition = definition();
  publicDefinition.launch.env = { MAX_TOKENS: "4096" };
  const redactor = new Redactor();
  const publicResult = await resolveRuntimeCredentials(publicDefinition, undefined, redactor);
  expect(publicResult.definition).toEqual(publicDefinition);
  expect(publicResult.privateValues).toBeUndefined();
  expect(redactor.hidesFrames).toBe(false);
  await expect(resolveRuntimeCredentials(definition(), undefined, redactor)).rejects.toThrow(
    "runtime_credentials_unavailable",
  );
  const literal = definition();
  literal.launch.env.API_KEY = "synthetic-credential-literal";
  await expect(
    resolveRuntimeCredentials(
      literal,
      {
        async read() {
          throw new Error("must not read");
        },
      },
      redactor,
    ),
  ).rejects.toThrow("definition_private_configuration_required");
  for (const value of [undefined, {}, "", "contains\0nul", "x".repeat(16384)]) {
    await expect(
      resolveRuntimeCredentials(
        definition(),
        {
          async read() {
            return value;
          },
        },
        redactor,
      ),
    ).rejects.toThrow("runtime_credentials_unavailable");
  }
  await expect(
    resolveRuntimeCredentials(
      definition(),
      {
        async read() {
          throw new Error("synthetic-private-vault-failure");
        },
      },
      redactor,
    ),
  ).rejects.toThrow(/^runtime_credentials_unavailable$/);
});
it("captures an independent definition before asynchronous vault reads and refuses credential arguments", async () => {
  const source = definition();
  let release: ((value: unknown) => void) | undefined;
  const pending = resolveRuntimeCredentials(
    source,
    {
      read: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    new Redactor(),
  );
  source.launch.command = "changed-during-lookup";
  source.launch.env.MAX_TOKENS = "1";
  release?.("synthetic-private-value");
  const result = await pending;
  expect(result.definition.launch.command).toBe("synthetic");
  expect(result.definition.launch.env.MAX_TOKENS).toBe("4096");
  const argv = definition();
  argv.launch.args = [reference];
  await expect(
    resolveRuntimeCredentials(
      argv,
      {
        async read() {
          throw new Error("must not read");
        },
      },
      new Redactor(),
    ),
  ).rejects.toThrow("runtime_credential_location_unsupported");
});
