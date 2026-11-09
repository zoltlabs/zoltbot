import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { connectionHealth } from "../../connections/src/health.js";
import { importConnectionMetadata } from "../../connections/src/imports.js";
import { resolveConnections } from "../../connections/src/materialize.js";
import { requestJson } from "../../connections/src/network.js";
import {
  connectionRecipes,
  recipeResource,
  type ServiceId,
} from "../../connections/src/recipes.js";
import { type ConnectionRecord, ConnectionRegistry } from "../../connections/src/registry.js";
import {
  availableBrokerServices,
  brokerOrigin,
  integrationPath,
  isBrokerService,
} from "../../connections/src/service-catalog.js";
import { connectionsAuth } from "./connections-auth.js";
import { connectionWrite } from "./connections-write.js";
import { startGoogleAdapter } from "./google-adapter.js";
import type { PrivateVault } from "./private-context.js";
import type { PublicWriteCheck } from "./private-input.js";

export function connectionsApi(options: {
  store: Store;
  vault?: PrivateVault;
  remember?(value: string): void;
  checkPublic?(value: unknown): Promise<PublicWriteCheck>;
  publish?(events: DomainEvent[]): void;
  onChanged?(): void;
  stopSession?(sessionId: string): Promise<void>;
  catalogStatus?(): Promise<string[]>;
}) {
  const { store } = options;
  const registry = new ConnectionRegistry(store.database);
  const mutate = <T>(
    commandId: string | undefined,
    method: string,
    params: unknown,
    produce: (state: ReturnType<Store["snapshot"]>) => T,
  ) => {
    const before = store.lastSeq();
    const value = connectionWrite(store, commandId, method, params, produce);
    const events = store.eventsSince(before);
    if (events.length) {
      options.publish?.(events);
      options.onChanged?.();
    }
    return value;
  };
  const auth = connectionsAuth({
    save: (value, version) =>
      mutate(randomUUID(), "connection.auth.complete", { id: value.id, version }, () =>
        registry.save(value, version),
      ),
    registry,
    ...(options.vault ? { vault: options.vault } : {}),
    ...(options.remember ? { remember: options.remember } : {}),
  });
  const affected = (id: string) => {
    const state = store.snapshot(["session", "settings"]);
    return (state.session ?? [])
      .filter((s) => s.state !== "closed" && s.state !== "failed")
      .filter((session) => {
        const config = state.settings?.find(
          (row) => row.key === `runtime.configuration.${session.id}`,
        )?.value as { launchManifest?: { connections?: { id: string }[] } } | undefined;
        return config?.launchManifest?.connections?.some((connection) => connection.id === id);
      })
      .map((session) => String(session.id));
  };
  return {
    close: () => auth.close(),
    api: async (method: string, params: Record<string, unknown>, commandId?: string) => {
      const authenticated = await auth.api(method, params);
      if (authenticated !== undefined) return authenticated;
      if (!method.startsWith("connection.")) return undefined;
      if (method === "connection.catalog.list") {
        let configured: string[] = [];
        let statusChecked = false;
        try {
          if (options.catalogStatus) configured = await options.catalogStatus();
          else {
            const origin = brokerOrigin();
            const response = await requestJson(
              `${origin}${integrationPath}/catalog`,
              { origins: [origin] },
              undefined,
              { signal: AbortSignal.timeout(2500) },
            );
            configured = availableBrokerServices(
              response,
              process.env.ZOLTBOT_GOOGLE_TEST_MODE === "1",
            );
          }
          statusChecked = true;
        } catch {
          /* Registration service may not yet be deployed. Direct OAuth still works. */
        }
        return {
          items: connectionRecipes.map((recipe) => ({
            ...recipe,
            availability:
              !isBrokerService(recipe.id) || configured.includes(recipe.id)
                ? "available"
                : statusChecked
                  ? "registration_required"
                  : "unavailable",
          })),
        };
      }
      if (method === "connection.list")
        return { items: registry.list(params.projectId as string | undefined) };
      if (method === "connection.affectedSessions")
        return { sessionIds: affected(String(params.id)) };
      const commandCheck = commandId ? await options.checkPublic?.(commandId) : undefined;
      const write = <T>(produce: (state: ReturnType<Store["snapshot"]>) => T) =>
        mutate(commandId, method, params, (state) => {
          commandCheck?.(state);
          return produce(state);
        });
      if (method === "connection.install") {
        const projectId = String(params.projectId);
        const serviceId = params.serviceId as ServiceId;
        const url = recipeResource(
          serviceId,
          params.organization as string | undefined,
          params.serviceProject as string | undefined,
        );
        if (
          serviceId === "posthog" &&
          (typeof params.serviceProject !== "string" ||
            !/^[1-9][0-9]{0,19}$/.test(params.serviceProject))
        )
          throw new Error("connection_posthog_project_required");
        const id = randomUUID();
        return write((state) => {
          if (!state.project?.some((p) => p.id === projectId && !p.archived))
            throw new Error("connection_scope_denied");
          return registry.save(
            {
              id,
              name: `${serviceId}_${id.slice(0, 8)}`,
              projectId,
              version: 1,
              source: `catalog:${serviceId}:v1`,
              ...(serviceId === "posthog"
                ? { posthog: { projectId: String(params.serviceProject) } }
                : {}),
              transport: { kind: "https", url },
              schemaTokens: { value: 512, source: "estimated" },
              enabled: false,
              profileIds: [],
              credentialStatus: "needs_sign_in",
              health: "not_checked",
            },
            0,
          );
        });
      }
      if (method === "connection.disable") {
        return write(() => {
          const current = registry.get(String(params.id));
          registry.save(
            { ...current, profileIds: current.profileIds.filter((id) => id !== params.profileId) },
            current.version,
          );
          return { ok: true };
        });
      }
      if (method === "connection.import") {
        if (params.confirmed !== true) throw new Error("connection_confirmation_required");
        const projectId = String(params.projectId),
          project = store.record("project", projectId);
        if (!project || project.archived) throw new Error("connection_scope_denied");
        const roots = project.roots as { path: string }[];
        const entries = store
          .snapshot(["settings"])
          .settings?.find((row) => row.key === "mcp.registry")?.value;
        const eligible = Array.isArray(entries)
          ? entries.filter(
              (entry) => !entry.scopePath || roots.some((root) => root.path === entry.scopePath),
            )
          : [];
        const check = await options.checkPublic?.(eligible);
        return write((state) => {
          check?.(state);
          return { imported: importConnectionMetadata(registry, eligible, projectId).length };
        });
      }
      if (method === "connection.test") {
        const current = registry.get(String(params.id));
        let google: Awaited<ReturnType<typeof startGoogleAdapter>> | undefined;
        const resolved = await resolveConnections(
          [current],
          options.vault ?? {
            read: async () => {
              throw new Error("keychain_unavailable");
            },
          },
          () => {},
          (secret) => options.remember?.(secret),
          async (descriptor, read) => {
            google = await startGoogleAdapter(
              descriptor,
              read,
              () => registry.assertUsable(descriptor),
              (secret) => options.remember?.(secret),
            );
            return google.connection;
          },
        );
        try {
          if (!resolved[0]) throw new Error("connection_not_ready");
          const health = await connectionHealth(current, resolved[0]);
          write(() =>
            registry.recordHealth(current.id, current.version, health.health, health.checkedAt),
          );
          return { ok: true };
        } catch {
          write(() =>
            registry.recordHealth(
              current.id,
              current.version,
              "unavailable",
              new Date().toISOString(),
            ),
          );
          throw new Error("connection_health_failed");
        } finally {
          await google?.close();
        }
      }
      if (method === "connection.save") {
        const value = params.value as ConnectionRecord;
        if (params.expectedVersion === 0 && value.source.startsWith("catalog:"))
          throw new Error("connection_catalog_install_required");
        if (Number(params.expectedVersion) > 0) {
          const prior = registry.get(value.id);
          if (
            (prior.source.startsWith("catalog:") || value.source.startsWith("catalog:")) &&
            (prior.source !== value.source ||
              JSON.stringify(prior.transport) !== JSON.stringify(value.transport) ||
              JSON.stringify(prior.posthog) !== JSON.stringify(value.posthog))
          )
            throw new Error("connection_catalog_resource_immutable");
          if (
            prior.source.startsWith("catalog:") &&
            value.enabled &&
            prior.credentialStatus !== "connected"
          )
            throw new Error("connection_sign_in_required");
        }
        const check = await options.checkPublic?.(value);
        const state = store.snapshot(["project", "agent"]);
        if (
          !state.project?.some((p) => p.id === value.projectId && !p.archived) ||
          value.profileIds.some((id) => !state.agent?.some((p) => p.id === id && !p.archived))
        )
          throw new Error("connection_scope_denied");
        if (value.transport.kind === "stdio") {
          const prior = Number(params.expectedVersion) > 0 ? registry.get(value.id) : undefined;
          value.executionApproved =
            params.executionConfirmed === true ||
            (prior?.executionApproved === true &&
              JSON.stringify(prior.transport) === JSON.stringify(value.transport));
          if (value.enabled && !value.executionApproved)
            throw new Error("connection_execution_confirmation_required");
        }
        if (
          params.expectedVersion === 0 &&
          (value.credentialReference || value.credentialStatus === "connected")
        )
          throw new Error("connection_sign_in_required");
        if (Number(params.expectedVersion) > 0) {
          const prior = registry.get(value.id);
          if (
            prior.credentialReference !== value.credentialReference ||
            prior.credentialStatus !== value.credentialStatus
          )
            throw new Error("connection_authentication_immutable");
        }
        return write((current) => {
          check?.(current);
          return registry.save(value, Number(params.expectedVersion), params.confirmed === true);
        });
      }
      if (method === "connection.disconnect") {
        if (params.confirmed !== true) throw new Error("connection_confirmation_required");
        const cleanup = write(() => {
          const ids = affected(String(params.id));
          if (ids.length && params.stopSessions !== true)
            throw new Error("connection_active_sessions");
          if (ids.length && !options.stopSession) throw new Error("connection_stop_unavailable");
          const prior = registry.get(String(params.id));
          if (
            prior.version !== params.expectedVersion ||
            !Array.isArray(params.expectedSessionIds) ||
            JSON.stringify([...ids].sort()) !==
              JSON.stringify([...params.expectedSessionIds].sort())
          )
            throw new Error("connection_disconnect_changed");
          const { credentialReference, ...without } = prior;
          registry.save(
            {
              ...without,
              enabled: false,
              revokedThroughVersion: prior.version,
              credentialStatus:
                prior.credentialStatus === "not_required" ? "not_required" : "needs_sign_in",
            },
            prior.version,
          );
          return { ids, credentialReference };
        });
        if (cleanup.credentialReference) await options.vault?.remove?.(cleanup.credentialReference);
        for (const id of cleanup.ids) await options.stopSession?.(id);
        return { ok: true };
      }
      return undefined;
    },
  };
}
