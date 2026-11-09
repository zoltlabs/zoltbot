import { type AgentDefinition, AgentDefinitionSchema, parse } from "@zoltbot/protocol";
import { assertPublicDefinition } from "./definition-configuration.js";
import { listDefinitions } from "./definition-list.js";
export interface SetupService {
  scan(paths?: string[]): Promise<unknown>;
  definitions(): Promise<{ definitions: AgentDefinition[] }>;
  login(id: string): Promise<unknown>;
  imports: {
    preview(options: {
      consent: boolean;
      sources: string[];
      codeFolders?: string[];
    }): Promise<{ id: string; items: unknown[] }>;
    apply(id: string, selected: string[], consent: boolean): Promise<unknown>;
  };
  report(): Promise<unknown>;
  fix(id: string, action: string, confirmed: boolean): Promise<{ processId?: string }>;
  updates(): Promise<unknown[]>;
  update(id: string, confirmed: boolean): Promise<{ version?: string }>;
  upsert(value: unknown): Promise<unknown>;
  probe(command: string): Promise<unknown>;
}
function string(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (typeof value !== "string") throw new Error("invalid_setup_params");
  return value;
}
function strings(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("invalid_setup_params");
  return value as string[];
}
export function setupApi(
  service: SetupService,
  options: { checkPublic?(value: unknown): Promise<void> } = {},
) {
  return async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "detect.scan":
        return service.scan(params.paths === undefined ? undefined : strings(params, "paths"));
      case "detect.checkLogin":
        return service.login(string(params, "definitionId"));
      case "detect.startLogin": {
        const result = await service.fix(string(params, "definitionId"), "login", true);
        if (!result.processId) throw new Error("visible_login_host_unavailable");
        return { processId: result.processId };
      }
      case "import.preview": {
        const preview = await service.imports.preview({
          consent: params.consent === true,
          sources: strings(params, "sources"),
          ...(params.codeFolders === undefined
            ? {}
            : { codeFolders: strings(params, "codeFolders") }),
        });
        return { previewId: preview.id, items: preview.items };
      }
      case "import.apply":
        await service.imports.apply(
          string(params, "previewId"),
          strings(params, "selected"),
          params.consent === true,
        );
        return { ok: true };
      case "doctor.report":
        return service.report();
      case "doctor.fix":
        await service.fix(
          string(params, "definitionId"),
          string(params, "action"),
          params.confirmed === true,
        );
        return { ok: true };
      case "update.list":
        return { updates: await service.updates() };
      case "update.run":
        return service.update(string(params, "definitionId"), params.confirmed === true);
      case "agentDefinition.list": {
        const page = listDefinitions((await service.definitions()).definitions, params);
        await options.checkPublic?.(page);
        return page;
      }
      case "agentDefinition.upsert": {
        const value = parse(AgentDefinitionSchema, params.value);
        assertPublicDefinition(value);
        await options.checkPublic?.(value);
        return service.upsert(value);
      }
      case "agentDefinition.probe":
        return service.probe(
          [string(params, "command"), ...strings(params, "args")]
            .map((item) => JSON.stringify(item))
            .join(" "),
        );
      default:
        return undefined;
    }
  };
}

export function deferredSetup(load: () => Promise<SetupService>): SetupService {
  let pending: Promise<SetupService> | undefined;
  const get = () => {
    pending ??= load().catch(() => {
      pending = undefined;
      throw new Error("setup_service_unavailable");
    });
    return pending;
  };
  return {
    scan: async (paths) => (await get()).scan(paths),
    definitions: async () => (await get()).definitions(),
    login: async (id) => (await get()).login(id),
    imports: {
      preview: async (options) => (await get()).imports.preview(options),
      apply: async (id, selected, consent) => (await get()).imports.apply(id, selected, consent),
    },
    report: async () => (await get()).report(),
    fix: async (id, action, confirmed) => (await get()).fix(id, action, confirmed),
    updates: async () => (await get()).updates(),
    update: async (id, confirmed) => (await get()).update(id, confirmed),
    upsert: async (value) => (await get()).upsert(value),
    probe: async (command) => (await get()).probe(command),
  };
}
