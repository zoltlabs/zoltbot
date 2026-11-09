import { randomUUID } from "node:crypto";
import type {
  ConnectionOAuth,
  OAuthConfiguration,
  OAuthPending,
} from "../../connections/src/oauth.js";
import { ConnectionOAuth as OAuth } from "../../connections/src/oauth.js";
import { recipeAuthorization, type ServiceId } from "../../connections/src/recipes.js";
import type { ConnectionRecord, ConnectionRegistry } from "../../connections/src/registry.js";
import type { PrivateVault } from "./private-context.js";

export function connectionsAuth(options: {
  registry: ConnectionRegistry;
  vault?: PrivateVault;
  save?(value: ConnectionRecord, version: number): unknown;
  remember?(value: string): void;
}) {
  const attempts = new Map<
    string,
    {
      connectionId: string;
      version: number;
      pending: OAuthPending;
      state: "waiting" | "connected" | "failed" | "cancelled";
    }
  >();
  const oauth: ConnectionOAuth | undefined = options.vault
    ? new OAuth({
        ...(options.vault.remove
          ? {
              remove: async (reference: string) => {
                await options.vault?.remove?.(reference);
              },
            }
          : {}),
        put: async (value) => {
          const record = value as { accessToken?: string; refreshToken?: string };
          if (record.accessToken) options.remember?.(record.accessToken);
          if (record.refreshToken) options.remember?.(record.refreshToken);
          return (options.vault as PrivateVault).put(value);
        },
      })
    : undefined;
  return {
    close() {
      for (const attempt of attempts.values())
        if (attempt.state === "waiting") attempt.pending.cancel();
      attempts.clear();
    },
    async api(method: string, params: Record<string, unknown>) {
      if (method === "connection.auth.start") {
        if (!oauth) throw new Error("keychain_unavailable");
        if (params.confirmed !== true) throw new Error("connection_confirmation_required");
        const connection = options.registry.get(String(params.id));
        if (connection.transport.kind !== "https") throw new Error("oauth_transport_unsupported");
        const service =
          /^catalog:(linear|sentry|github|posthog|gmail|google_drive|google_docs|slack):v1$/.exec(
            connection.source,
          )?.[1] as ServiceId | undefined;
        const supplied = params.configuration as
          | (Omit<OAuthConfiguration, "identity" | "resource" | "policy"> & { origins: string[] })
          | undefined;
        if (
          !service &&
          (!supplied?.clientId ||
            !Array.isArray(supplied.scopes) ||
            !Array.isArray(supplied.origins))
        )
          throw new Error("oauth_registration_required");
        let config: OAuthConfiguration;
        if (service)
          config = await recipeAuthorization(service, connection.transport.url, connection.id);
        else {
          if (!supplied) throw new Error("oauth_registration_required");
          config = {
            ...supplied,
            identity: connection.id,
            resource: connection.transport.url,
            policy: { origins: supplied.origins },
          };
        }
        const pending = await oauth.start(config);
        const id = randomUUID();
        const attempt = {
          connectionId: connection.id,
          version: connection.version,
          pending,
          state: "waiting" as "waiting" | "connected" | "failed" | "cancelled",
        };
        attempts.set(id, attempt);
        // Token exchange completes privately; public polling returns only a status label.
        void pending.result
          .then(async ({ reference }) => {
            try {
              const current = options.registry.get(connection.id);
              if (current.version !== attempt.version || attempt.state !== "waiting")
                throw new Error("connection_changed");
              (options.save ?? options.registry.save.bind(options.registry))(
                {
                  ...current,
                  ...(service
                    ? { enabled: false, profileIds: [], health: "not_checked" as const }
                    : {}),
                  credentialReference: reference,
                  credentialStatus: "connected",
                },
                current.version,
              );
              attempt.state = "connected";
            } catch {
              await options.vault?.remove?.(reference);
              throw new Error("connection_auth_attach_failed");
            }
          })
          .catch(() => {
            if (attempt.state !== "cancelled") attempt.state = "failed";
          });
        // Bound retained attempts; never persist callback state or authorization codes.
        for (const [key, old] of attempts)
          if (attempts.size > 100 && old.state !== "waiting") attempts.delete(key);
        return {
          id,
          authorizationUrl: pending.authorizationUrl,
          destination: new URL(config.authorizationEndpoint).host,
          scopes: config.scopes,
        };
      }
      if (method === "connection.auth.status" || method === "connection.auth.cancel") {
        const attempt = attempts.get(String(params.id));
        if (!attempt) throw new Error("oauth_attempt_not_found");
        if (method === "connection.auth.cancel" && attempt.state === "waiting") {
          attempt.state = "cancelled";
          attempt.pending.cancel();
        }
        return { state: attempt.state };
      }
      return undefined;
    },
  };
}
