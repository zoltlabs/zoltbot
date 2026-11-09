import { randomUUID } from "node:crypto";
import {
  type AgentDefinition,
  type QuickBilling,
  type QuickConnection,
  type QuickModel,
  type QuickSettings,
  type QuickTool,
  quickTools,
} from "@zoltbot/protocol";
import type { PrivateVault } from "../private-context.js";
import {
  anthropicMessages,
  type FetchLike,
  type InferenceAdapter,
  InferenceError,
  openAICompatible,
  openAIResponses,
} from "./providers.js";
import { publicConnection, type QuickRepository, type StoredConnection } from "./repository.js";
import { type QuickToolRuntime, toolInference, toolLabels, toolRecommendation } from "./tools.js";

// Quick Chat connections: coding tools the person signed in to on this host, their own API keys,
// and local endpoints. Secrets go to the Keychain by reference and are registered for redaction.

type Params = Record<string, unknown>;
export type ConnectionEntry = { row: StoredConnection; secretRef: string | null };
const now = () => new Date().toISOString();
const privateHost = (url: URL) =>
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
    url.hostname,
  ) || url.hostname.endsWith(".local");
/** A cheap conversational model to suggest first; the person can always choose another. */
export function recommendedModel(models: readonly QuickModel[]): string | undefined {
  const fast = /(mini|nano|haiku|flash|luna|small|lite|instant)/i;
  return (models.find((model) => fast.test(model.id)) ?? models[0])?.id;
}
const isTool = (value: string): value is QuickTool =>
  (quickTools as readonly string[]).includes(value);
export function quickConnections(options: {
  repo: QuickRepository;
  vault?: PrivateVault;
  remember(value: string): void;
  connectionChanged(id: string): void;
  host: { id: string; name: string };
  endpoints?: { openai?: string; anthropic?: string };
  fetch: FetchLike;
  /** Coding tools configured on this host, from the agent definitions. */
  definitions(): AgentDefinition[] | Promise<AgentDefinition[]>;
  tools?: QuickToolRuntime;
}) {
  const { repo, host, connectionChanged } = options;
  const fetcher = options.fetch;
  let definitions: AgentDefinition[] = [];
  const definition = (tool: QuickTool) =>
    definitions.find((row) => row.id === tool && !row.experimental);
  const tools = options.tools ? toolInference({ runtime: options.tools, definition }) : undefined;
  const settings = (): QuickSettings => repo.settings();
  // Sign in with ChatGPT was removed; drop any connection left from it.
  for (const entry of repo.connections())
    if (!["coding_tool", "api_key", "local"].includes(entry.row.kind)) {
      if (entry.secretRef) void options.vault?.remove?.(entry.secretRef).catch(() => {});
      repo.removeConnection(entry.row.id);
    }
  const remember = (value: string | undefined) => {
    if (value) options.remember(value);
  };
  const vault = () => {
    if (!options.vault) throw new Error("keychain_unavailable: secrets need the Mac Keychain");
    return options.vault;
  };
  const readSecret = async (reference: string | null) => {
    if (!reference) return undefined;
    const value = (await vault().read(reference)) as Record<string, unknown>;
    return value;
  };
  const updateConnection = (
    id: string,
    change: Partial<StoredConnection>,
    secretRef?: string | null,
  ) => {
    const entry = repo.connection(id);
    if (!entry) return;
    repo.saveConnection(
      { ...entry.row, ...change, updatedAt: now() },
      secretRef === undefined ? entry.secretRef : secretRef,
    );
    connectionChanged(id);
  };
  const adapter = (entry: {
    row: StoredConnection;
    secretRef: string | null;
  }): InferenceAdapter => {
    const { row, secretRef } = entry;
    if (row.kind === "coding_tool") {
      if (!tools || !isTool(row.provider))
        throw new InferenceError("unreachable", "refused", "Coding tools are not available.");
      return tools.adapter(row.provider);
    }
    const key = async () => {
      const value = (await readSecret(secretRef))?.apiKey;
      if (typeof value === "string") remember(value);
      return typeof value === "string" ? value : undefined;
    };
    if (row.kind === "local")
      return openAICompatible({ baseUrl: row.baseUrl ?? "", apiKey: key, fetch: fetcher });
    const required = async () => {
      const value = await key();
      if (!value) throw new InferenceError("sign_in_required", "refused", "Add your API key.");
      return value;
    };
    return row.provider === "anthropic"
      ? anthropicMessages({
          baseUrl: options.endpoints?.anthropic ?? "https://api.anthropic.com",
          apiKey: required,
          fetch: fetcher,
        })
      : openAIResponses({
          baseUrl: options.endpoints?.openai ?? "https://api.openai.com/v1",
          fetch: fetcher,
          token: required,
        });
  };
  /** Discovers models from the connection itself; configured names are kept for local servers. */
  const refreshModels = async (id: string) => {
    const entry = repo.connection(id);
    if (!entry) throw new Error("quick_connection_unavailable");
    try {
      if (entry.row.kind === "coding_tool") definitions = await options.definitions();
      const discovered = await adapter(entry).listModels(AbortSignal.timeout(30_000));
      const configured = entry.row.models.filter(
        (model) => model.source === "configured" && !discovered.some((d) => d.id === model.id),
      );
      const models = [...discovered, ...configured].slice(0, 500);
      const recommended =
        entry.row.kind === "coding_tool" && isTool(entry.row.provider)
          ? (toolRecommendation(entry.row.provider, models) ?? recommendedModel(models))
          : recommendedModel(models);
      updateConnection(id, {
        models,
        modelsCheckedAt: now(),
        ...(recommended ? { recommendedModel: recommended } : {}),
        status: models.length ? "ready" : "unavailable",
        statusDetail: models.length ? "" : "No models are available.",
      });
    } catch (error) {
      const code = error instanceof InferenceError ? error.code : "unavailable";
      updateConnection(id, {
        status:
          code === "sign_in_required"
            ? "needs_sign_in"
            : entry.row.models.length && entry.row.kind === "local"
              ? "ready"
              : "unavailable",
        statusDetail: error instanceof Error ? error.message.slice(0, 200) : "Unavailable",
        modelsCheckedAt: now(),
      });
    }
    return view(id);
  };
  const view = (id: string): QuickConnection => {
    const entry = repo.connection(id);
    if (!entry) throw new Error("quick_connection_unavailable");
    return publicConnection(entry.row, entry.secretRef);
  };
  async function saveApiKey(params: Params) {
    const provider = params.provider as "openai" | "anthropic";
    const existing = typeof params.id === "string" ? repo.connection(params.id) : undefined;
    if (params.id && (!existing || existing.row.kind !== "api_key"))
      throw new Error("quick_connection_unavailable");
    if (!existing && typeof params.apiKey !== "string")
      throw new Error("quick_api_key_required: paste your own API key");
    let secretRef = existing?.secretRef ?? null;
    if (typeof params.apiKey === "string") {
      const apiKey = params.apiKey.trim();
      remember(apiKey);
      if (secretRef && options.vault?.replace) await options.vault.replace(secretRef, { apiKey });
      else secretRef = (await vault().put({ apiKey })).reference;
    }
    const at = now();
    const row: StoredConnection = {
      id: existing?.row.id ?? randomUUID(),
      kind: "api_key",
      provider,
      label: String(params.label),
      billing: "user_api_key",
      host,
      status: "unavailable",
      models: existing?.row.models ?? [],
      hasSecret: true,
      createdAt: existing?.row.createdAt ?? at,
      updatedAt: at,
    };
    repo.saveConnection(row, secretRef);
    return refreshModels(row.id);
  }
  async function saveLocal(params: Params) {
    let url: URL;
    try {
      url = new URL(String(params.baseUrl));
    } catch {
      throw new Error("quick_endpoint_invalid: use an http:// or https:// address");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error(
        "quick_endpoint_invalid: use an http:// or https:// address without a password",
      );
    if (url.protocol === "http:" && !privateHost(url))
      throw new Error(
        "quick_endpoint_invalid: plain http is allowed only on this Mac or a private network",
      );
    const existing = typeof params.id === "string" ? repo.connection(params.id) : undefined;
    if (params.id && (!existing || existing.row.kind !== "local"))
      throw new Error("quick_connection_unavailable");
    let secretRef = existing?.secretRef ?? null;
    if (typeof params.apiKey === "string") {
      remember(params.apiKey);
      if (secretRef && options.vault?.replace)
        await options.vault.replace(secretRef, { apiKey: params.apiKey });
      else secretRef = (await vault().put({ apiKey: params.apiKey })).reference;
    }
    const configured = ((params.models as string[] | undefined) ?? []).map((id) => ({
      id,
      label: id,
      source: "configured" as const,
    }));
    const at = now();
    const row: StoredConnection = {
      id: existing?.row.id ?? randomUUID(),
      kind: "local",
      provider: "openai_compatible",
      label: String(params.label),
      // A remote endpoint is billed to whoever runs it, so it is never labelled local.
      billing: (privateHost(url) ? "local" : "user_api_key") as QuickBilling,
      host,
      baseUrl: url.toString().replace(/\/+$/, ""),
      status: "unavailable",
      models: configured,
      hasSecret: Boolean(secretRef),
      createdAt: existing?.row.createdAt ?? at,
      updatedAt: at,
    };
    repo.saveConnection(row, secretRef);
    return refreshModels(row.id);
  }
  /** One connection per installed coding tool, unless the person removed it. */
  const hidden = () => repo.setting<QuickTool[]>("tools.hidden") ?? [];
  const checking = new Set<string>();
  const discoveries = new Map<string, Promise<unknown>>();
  async function syncTools() {
    if (!tools) return;
    definitions = await options.definitions();
    for (const tool of quickTools) {
      if (!definition(tool) || hidden().includes(tool)) continue;
      let entry = repo.connections().find((row) => row.row.provider === tool);
      if (!entry) {
        const at = now();
        const row: StoredConnection = {
          id: randomUUID(),
          kind: "coding_tool",
          provider: tool,
          label: toolLabels[tool],
          billing: "tool_sign_in",
          host,
          status: "unavailable",
          statusDetail: "Checking the models it offers…",
          models: [],
          hasSecret: false,
          createdAt: at,
          updatedAt: at,
        };
        repo.saveConnection(row, null);
        entry = { row, secretRef: null };
      }
      // Discover models once per daemon run; opening a session starts no inference.
      const id = entry.row.id;
      if (!checking.has(id)) {
        checking.add(id);
        discoveries.set(
          id,
          refreshModels(id).catch(() => {}),
        );
      }
    }
  }
  const order = (row: StoredConnection) =>
    isTool(row.provider) ? quickTools.indexOf(row.provider) : quickTools.length;

  return {
    settings,
    syncTools,
    async ensureTools() {
      await syncTools();
      await Promise.all(discoveries.values());
    },
    adapter,
    updateConnection,
    async close() {
      await tools?.close();
    },
    async api(method: string, params: Params): Promise<unknown> {
      switch (method) {
        case "quickConnection.list":
          await syncTools();
          return {
            items: repo
              .connections()
              .filter((entry) => entry.row.kind !== "coding_tool" || tools)
              .sort((a, b) => order(a.row) - order(b.row))
              .map((entry) => publicConnection(entry.row, entry.secretRef)),
            settings: settings(),
          };
        case "quickConnection.addTool": {
          const tool = String(params.tool);
          await syncTools();
          if (!isTool(tool) || !definition(tool)) throw new Error("quick_tool_unavailable");
          repo.setSetting(
            "tools.hidden",
            hidden().filter((value) => value !== tool),
          );
          await syncTools();
          const entry = repo.connections().find((row) => row.row.provider === tool);
          if (!entry) throw new Error("quick_tool_unavailable");
          return refreshModels(entry.row.id);
        }
        case "quickConnection.saveApiKey":
          return saveApiKey(params);
        case "quickConnection.saveLocal":
          return saveLocal(params);
        case "quickConnection.refreshModels":
          return refreshModels(String(params.id));
        case "quickConnection.remove": {
          const id = String(params.id);
          const entry = repo.connection(id);
          if (!entry) throw new Error("quick_connection_unavailable");
          if (entry.secretRef) await options.vault?.remove?.(entry.secretRef).catch(() => {});
          if (entry.row.kind === "coding_tool" && isTool(entry.row.provider))
            repo.setSetting("tools.hidden", [...new Set([...hidden(), entry.row.provider])]);
          repo.removeConnection(id);
          const { defaultConnectionId, defaultModel, fallback, ...rest } = repo.settings();
          repo.saveSettings({
            ...rest,
            ...(defaultConnectionId && defaultConnectionId !== id
              ? { defaultConnectionId, ...(defaultModel ? { defaultModel } : {}) }
              : {}),
            ...(fallback && fallback.connectionId !== id ? { fallback } : {}),
            deeperModels: Object.fromEntries(
              Object.entries(rest.deeperModels).filter(([key]) => key !== id),
            ),
          });
          connectionChanged(id);
          return { ok: true };
        }
        case "quickConnection.setDefaults": {
          const current = repo.settings();
          const next = { ...current };
          if (typeof params.defaultConnectionId === "string") {
            const entry = repo.connection(params.defaultConnectionId);
            if (!entry) throw new Error("quick_connection_unavailable");
            next.defaultConnectionId = entry.row.id;
            if (typeof params.defaultModel === "string") {
              if (!entry.row.models.some((model) => model.id === params.defaultModel))
                throw new Error("quick_model_unavailable");
              next.defaultModel = params.defaultModel;
            }
          }
          const deeper = params.deeperModel as { connectionId: string; model: string } | undefined;
          if (deeper) {
            const entry = repo.connection(deeper.connectionId);
            if (!entry?.row.models.some((model) => model.id === deeper.model))
              throw new Error("quick_model_unavailable");
            next.deeperModels = { ...current.deeperModels, [deeper.connectionId]: deeper.model };
          }
          repo.saveSettings(next);
          return settings();
        }
        case "quickConnection.setFallback": {
          const current = repo.settings();
          if (params.enabled === false) {
            const { fallback: _off, ...rest } = current;
            repo.saveSettings(rest);
            return settings();
          }
          if (params.acknowledged !== true)
            throw new Error("quick_fallback_acknowledgement_required");
          const entry = repo.connection(String(params.connectionId));
          if (!entry?.row.models.some((model) => model.id === params.model))
            throw new Error("quick_model_unavailable");
          repo.saveSettings({
            ...current,
            fallback: {
              connectionId: entry.row.id,
              model: String(params.model),
              acknowledgedAt: now(),
            },
          });
          return settings();
        }
        default:
          return undefined;
      }
    },
  };
}
