import { createHash, randomUUID } from "node:crypto";
import type { Store } from "@zoltbot/store";
import {
  composeLaunchManifest,
  type LaunchContributions,
  type LaunchManifest,
} from "../../connections/src/launch-manifest.js";
import { resolveConnections } from "../../connections/src/materialize.js";
import { ConnectionOAuth, type OAuthCredential } from "../../connections/src/oauth.js";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { startGoogleAdapter } from "./google-adapter.js";
import type { Redactor } from "./logging.js";
import type { PrivateVault } from "./private-context.js";

export function connectionsRuntime(
  store: Store,
  vault?: PrivateVault,
  remember?: (secret: string) => void,
) {
  const bridges = new Map<
    string,
    Map<string, Promise<Awaited<ReturnType<typeof startGoogleAdapter>>>>
  >();
  const refreshes = new Map<string, Promise<unknown>>();
  const protect = (value: unknown) => {
    const credential = value as Partial<OAuthCredential>;
    if (typeof credential.accessToken === "string") remember?.(credential.accessToken);
    if (typeof credential.refreshToken === "string") remember?.(credential.refreshToken);
  };
  const oauth = vault
    ? new ConnectionOAuth({
        put: async (value) => {
          protect(value);
          return vault.put(value);
        },
        ...(vault.replace
          ? {
              replace: async (reference: string, value: unknown) => {
                protect(value);
                await vault.replace?.(reference, value);
              },
            }
          : {}),
      })
    : undefined;
  const registry = new ConnectionRegistry(store.database);
  return {
    async release(manifest: LaunchManifest) {
      const entries = bridges.get(manifest.id);
      bridges.delete(manifest.id);
      if (entries)
        await Promise.all([...entries.values()].map(async (entry) => (await entry).close()));
    },
    compose(
      input: {
        threadId: string;
        profileId: string;
        projectId?: string;
        taskId?: string;
        cwd: string;
        configuration: unknown;
        fixed: number;
      },
      contributions: LaunchContributions = {},
    ): LaunchManifest {
      const task = input.taskId ? store.record("task", input.taskId) : undefined;
      return composeLaunchManifest(
        {
          executionId: randomUUID(),
          threadId: input.threadId,
          profileId: input.profileId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.taskId
            ? { taskId: input.taskId, taskRevision: Number(task?.revision ?? 1) }
            : {}),
          cwd: input.cwd,
          configurationHash: createHash("sha256")
            .update(JSON.stringify(input.configuration))
            .digest("hex"),
        },
        contributions,
        { limit: 1500, fixed: input.fixed },
      );
    },
    select(projectId: string | undefined, profileId: string, supported: boolean) {
      const ready = store.database
        .prepare("SELECT name FROM sqlite_master WHERE name='connections_aux'")
        .get();
      return ready ? registry.effective(projectId, profileId, supported) : [];
    },
    validate(manifest: LaunchManifest, fresh: boolean) {
      for (const descriptor of manifest.connections) {
        registry.assertUsable(descriptor);
        const current = registry.get(descriptor.id);
        if (fresh && current.version !== descriptor.version)
          throw new Error("runtime_configuration_changed");
      }
    },
    async resolve(manifest: LaunchManifest, redactor: Redactor, preflight = false) {
      return resolveConnections(
        manifest.connections,
        {
          read: async (reference) => {
            if (!vault) throw new Error("connection_credentials_unavailable");
            const prior = (await vault.read(reference)) as OAuthCredential;
            const descriptor = manifest.connections.find(
              (entry) => entry.credentialReference === reference,
            );
            if (
              !descriptor ||
              descriptor.transport.kind !== "https" ||
              prior?.resource !== descriptor.transport.url
            )
              throw new Error("connection_credentials_unavailable");
            if (prior.expiresAt === undefined || prior.expiresAt > Date.now()) return prior;
            const registration = prior.registration;
            if (
              !oauth ||
              !vault.replace ||
              !registration ||
              registration.resource !== prior.resource ||
              registration.issuer !== prior.issuer ||
              !prior.refreshToken
            )
              throw new Error("connection_credentials_unavailable");
            registry.assertUsable(descriptor);
            let pending = refreshes.get(reference);
            if (!pending) {
              pending = oauth
                .refresh(registration, prior, reference)
                .then(() => vault.read(reference))
                .finally(() => refreshes.delete(reference));
              refreshes.set(reference, pending);
            }
            try {
              return await pending;
            } catch {
              throw new Error("connection_credentials_unavailable");
            }
          },
        },
        (descriptor) => {
          registry.assertUsable(descriptor);
        },
        (secret) => {
          remember?.(secret);
          redactor.register(secret);
          redactor.hideFrames();
        },
        async (descriptor, read) => {
          if (preflight) {
            if (descriptor.transport.kind !== "https") throw new Error("google_resource_invalid");
            return {
              name: descriptor.name,
              kind: "https",
              url: descriptor.transport.url,
              headers: {},
            };
          }
          let entries = bridges.get(manifest.id);
          if (!entries) {
            entries = new Map();
            bridges.set(manifest.id, entries);
          }
          let pending = entries.get(descriptor.id);
          if (!pending) {
            pending = startGoogleAdapter(
              descriptor,
              read,
              () => registry.assertUsable(descriptor),
              (secret) => {
                remember?.(secret);
                redactor.register(secret);
                redactor.hideFrames();
              },
            );
            entries.set(descriptor.id, pending);
            void pending.catch(() => entries?.delete(descriptor.id));
          }
          return (await pending).connection;
        },
      );
    },
  };
}
