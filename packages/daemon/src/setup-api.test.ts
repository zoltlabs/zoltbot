import { expect, it } from "vitest";
import { deferredSetup, setupApi } from "./setup-api.js";

it("routes consent, selected IDs, definitions, and confirmed actions to setup services", async () => {
  const calls: unknown[] = [];
  const service = {
    scan: async () => [],
    definitions: async () => ({ definitions: [], errors: [] }),
    login: async (id: string) => {
      calls.push(id);
      return { state: "unknown" };
    },
    imports: {
      preview: async (options: unknown) => {
        calls.push(options);
        return { id: "preview", items: [] };
      },
      apply: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    },
    report: async () => ({ checks: [] }),
    fix: async (...args: unknown[]) => {
      calls.push(args);
      return { processId: "visible" };
    },
    upsert: async (value: unknown) => {
      calls.push(["upsert", value]);
      return value;
    },
    probe: async (command: string) => {
      calls.push(command);
      return { error: "not_an_acp_agent" };
    },
    updates: async () => [{ definitionId: "sample", installed: "1.0.0", latest: "1.1.0" }],
    update: async (id: string, confirmed: boolean) => {
      calls.push(["update", id, confirmed]);
      return { version: "1.1.0" };
    },
  };
  let loads = 0;
  const lazy = deferredSetup(async () => {
    loads++;
    return service;
  });
  expect(loads).toBe(0);
  await Promise.all([lazy.scan(), lazy.definitions()]);
  expect(loads).toBe(1);
  const api = setupApi(service);
  expect(await api("detect.checkLogin", { definitionId: "sample" })).toEqual({ state: "unknown" });
  expect(await api("import.preview", { consent: true, sources: ["claude"] })).toEqual({
    previewId: "preview",
    items: [],
  });
  expect(
    await api("import.apply", { previewId: "preview", selected: ["item"], consent: true }),
  ).toEqual({ ok: true });
  expect(
    await api("doctor.fix", { definitionId: "sample", action: "login", confirmed: true }),
  ).toEqual({ ok: true });
  expect(await api("update.list", {})).toEqual({
    updates: [{ definitionId: "sample", installed: "1.0.0", latest: "1.1.0" }],
  });
  expect(await api("update.run", { definitionId: "sample", confirmed: true })).toEqual({
    version: "1.1.0",
  });
  expect(calls).toContainEqual(["update", "sample", true]);
  await api("agentDefinition.probe", { command: "opencode", args: ["acp"] });
  expect(calls).toContainEqual(["preview", ["item"], true]);
  expect(calls).toContainEqual(["sample", "login", true]);
  expect(calls).toContain('"opencode" "acp"');
  expect(await api("agentDefinition.list", {})).toEqual({ items: [] });
  const definition = {
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
  expect(await api("agentDefinition.upsert", { value: definition })).toEqual(definition);
  const beforeWrite = calls.length;
  await expect(
    api("agentDefinition.upsert", {
      value: {
        ...definition,
        launch: { ...definition.launch, args: ["--api-key", "synthetic-private-argument"] },
      },
    }),
  ).rejects.toThrow("definition_private_configuration_required");
  const guarded = setupApi(service, {
    checkPublic: async () => {
      throw new Error("private_value_requires_secure_field");
    },
  });
  await expect(guarded("agentDefinition.upsert", { value: definition })).rejects.toThrow(
    "private_value_requires_secure_field",
  );
  await expect(guarded("agentDefinition.list", {})).rejects.toThrow(
    "private_value_requires_secure_field",
  );
  expect(calls).toHaveLength(beforeWrite);
  expect(await api("unrelated", {})).toBeUndefined();
});
