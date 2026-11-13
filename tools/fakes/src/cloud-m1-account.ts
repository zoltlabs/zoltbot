import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CellTokenRequestSchema,
  type CloudDevice,
  CloudDeviceKeySchema,
  type CloudRunnerGrant,
  CloudRunnerGrantInputSchema,
  CloudSecretWriteSchema,
  type Credentials,
} from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";
import { verifyServiceToken } from "../../../packages/cell/src/service.js";
import { createCellIdentity } from "./cell-identity.js";

export interface FakeAccountRequest {
  path: string;
  method: string;
  authorization?: string;
  body: unknown;
}
interface Session {
  userId: string;
  orgId: string;
  deviceId: string;
  surface: "desktop" | "phone";
  credentials: Credentials;
  active: boolean;
  beta: boolean;
}
const opaque = () => randomBytes(32).toString("base64url");
const routes = {
  jwks: "/api/cloud/jwks.json",
  cell: "/api/cloud/cell-token",
  runner: "/api/cloud/runner-token",
  devices: "/api/cloud/devices",
  grants: "/api/cloud/runner-grants",
};
/** Loopback harness fixture, never a hosted server. All credential material stays in RAM. */
export async function createCloudM1Account(options: {
  issuer: string;
  cellUrl: string;
  serviceKey: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now,
    issuer = options.issuer,
    cellUrl = options.cellUrl,
    serviceKey = options.serviceKey;
  const identity = await createCellIdentity({ issuer, now });
  const sessions = new Map<string, Session>(),
    devices = new Map<string, CloudDevice>(),
    grants = new Map<string, CloudRunnerGrant>(),
    secrets = new Map<string, string>();
  const key = (user: string, name: string) => JSON.stringify([user, name]);
  const reply = (body: unknown, status = 200) => ({ body, status });
  const refused = () => reply({ error: "forbidden" }, 403);
  const access = (request: FakeAccountRequest) => {
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.authorization ?? "")?.[1];
    return [...sessions.values()].find((s) => s.active && s.credentials.accessToken === bearer);
  };
  const activeDevice = (session: Session) => {
    const device = devices.get(key(session.userId, session.deviceId));
    return device && !device.revokedAt ? device : undefined;
  };
  return Object.freeze({
    // The test's scripted native authorization creates its own session; HTTP cannot call this port.
    nativeSession(
      input: Pick<Session, "userId" | "orgId" | "deviceId" | "surface"> & { beta?: boolean },
    ) {
      const credentials = {
        sessionId: randomUUID(),
        accessToken: opaque(),
        refreshToken: opaque(),
      };
      sessions.set(credentials.sessionId, {
        ...input,
        beta: input.beta ?? true,
        active: true,
        credentials,
      });
      return structuredClone(credentials);
    },
    async handle(request: FakeAccountRequest) {
      try {
        const { path, method, body } = request;
        if (path === routes.jwks && method === "GET") return reply(identity.jwks());
        if (path === "/api/account/session/refresh" && method === "POST") {
          const refresh = /^Refresh ([A-Za-z0-9_-]{43})$/.exec(request.authorization ?? "")?.[1];
          const session = [...sessions.values()].find(
            (s) => s.active && s.credentials.refreshToken === refresh,
          );
          if (!session) return reply({ error: "sign_in_required" }, 401);
          session.credentials = {
            ...session.credentials,
            accessToken: opaque(),
            refreshToken: opaque(),
          };
          return reply(structuredClone(session.credentials));
        }
        if (
          ![...Object.values(routes), "/api/account/me", "/api/account/logout"].includes(path) &&
          !/^\/api\/cloud\/(?:devices\/[^/]+|secrets\/(?:anthropic|openai|github)|access)$/.test(
            path,
          )
        )
          return undefined;
        if (path.endsWith("/access") && method === "POST") {
          const input = body as Record<string, unknown>;
          if (
            !input ||
            typeof input.orgId !== "string" ||
            Object.keys(input).some(
              (name) =>
                ![
                  "orgId",
                  "userId",
                  "deviceId",
                  "kind",
                  "tokenId",
                  "surface",
                  "sessionId",
                  "grantId",
                  "taskId",
                ].includes(name),
            ) ||
            ["orgId", "userId", "deviceId", "kind", "tokenId", "surface"].some(
              (name) => typeof input[name] !== "string" || !input[name],
            )
          )
            return refused();
          const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.authorization ?? "")?.[1] ?? "";
          await verifyServiceToken(token, serviceKey, issuer, "orchestrator", input.orgId, now());
          const session = sessions.get(String(input.sessionId));
          const active =
            !!session &&
            session.active &&
            session.beta &&
            !!activeDevice(session) &&
            input.orgId === session.orgId &&
            input.userId === session.userId &&
            input.deviceId === session.deviceId;
          if (!active || !session) return reply({ active: false });
          if (input.kind === "client")
            return reply({
              active:
                input.surface === session.surface &&
                input.grantId === undefined &&
                input.taskId === undefined,
            });
          const grant = grants.get(key(session.userId, session.deviceId));
          return reply({
            active:
              input.kind === "mac_runner" &&
              input.surface === "runner" &&
              !!grant &&
              grant.id === input.grantId &&
              grant.sessionId === session.credentials.sessionId &&
              input.taskId === undefined &&
              Date.parse(grant.expiresAt) > now(),
            canRunTasks: grant?.canRunTasks ?? false,
            canMacExec: grant?.canMacExec ?? false,
          });
        }
        const session = access(request);
        if (!session) return reply({ error: "sign_in_required" }, 401);
        if (path === "/api/account/me" && method === "GET")
          return reply({
            sessionId: session.credentials.sessionId,
            user: { id: session.userId },
            organizations: [{ id: session.orgId, role: "owner" }],
          });
        if (path === "/api/account/logout" && method === "POST") {
          session.active = false;
          return reply({ ok: true });
        }
        if (!session.beta) return refused();
        if (path === routes.devices && method === "POST") {
          const input = parse(CloudDeviceKeySchema, body);
          const id = createHash("sha256")
            .update(Buffer.from(input.publicKey, "base64url"))
            .digest("base64url")
            .slice(0, 22);
          if (id !== input.deviceId || id !== session.deviceId) return refused();
          const previous = devices.get(key(session.userId, id));
          if (previous?.revokedAt || (previous && previous.publicKey !== input.publicKey))
            return refused();
          devices.set(key(session.userId, id), {
            ...input,
            userId: session.userId,
            registeredAt: new Date(now()).toISOString(),
          });
          return reply({ ok: true });
        }
        if (path === routes.devices && method === "GET")
          return reply({
            devices: [...devices.values()]
              .filter((d) => d.userId === session.userId)
              .map((d) => ({ ...d })),
          });
        if (path.startsWith(`${routes.devices}/`) && method === "DELETE") {
          const device = devices.get(key(session.userId, path.slice(routes.devices.length + 1)));
          if (!device) return refused();
          device.revokedAt = new Date(now()).toISOString();
          for (const item of sessions.values())
            if (item.userId === session.userId && item.deviceId === device.deviceId)
              item.active = false;
          grants.delete(key(session.userId, device.deviceId));
          return reply({ ok: true });
        }
        if (path === routes.grants && method === "PUT") {
          const input = parse(CloudRunnerGrantInputSchema, body);
          if (
            input.deviceId !== session.deviceId ||
            session.surface !== "desktop" ||
            !activeDevice(session)
          )
            return refused();
          const id = key(session.userId, session.deviceId);
          if (!input.canRunTasks && !input.canMacExec) {
            grants.delete(id);
            return reply({ grant: null });
          }
          const grant = {
            ...input,
            id: randomUUID(),
            sessionId: session.credentials.sessionId,
            expiresAt: new Date(now() + 86400000).toISOString(),
          };
          grants.set(id, grant);
          return reply({ grant: { ...grant } });
        }
        if ([routes.cell, routes.runner].includes(path) && method === "POST") {
          const input = parse(CellTokenRequestSchema, body);
          if (
            input.orgId !== session.orgId ||
            input.deviceId !== session.deviceId ||
            !activeDevice(session)
          )
            return refused();
          const grant = grants.get(key(session.userId, session.deviceId)),
            runner = path === routes.runner;
          if (
            runner &&
            (!grant ||
              grant.sessionId !== session.credentials.sessionId ||
              Date.parse(grant.expiresAt) <= now())
          )
            return refused();
          const token = await identity.issue({
            sub: session.userId,
            org: session.orgId,
            device: session.deviceId,
            session: session.credentials.sessionId,
            surface: runner ? "runner" : session.surface,
            kind: runner ? "mac_runner" : "client",
            ...(runner && grant ? { grant: grant.id } : {}),
          });
          return reply({
            token,
            cellUrl,
            expiresAt: new Date(Math.floor(now() / 1000) * 1000 + 600000).toISOString(),
          });
        }
        const secret = /^\/api\/cloud\/secrets\/(anthropic|openai|github)$/.exec(path)?.[1];
        if (secret && method === "PUT") {
          const input = parse(CloudSecretWriteSchema, body);
          secrets.set(key(session.userId, secret), input.value);
          return reply({ ok: true });
        }
        return reply({ error: "not_found" }, 404);
      } catch {
        return reply({ error: "fixture_request_refused" }, 400);
      }
    },
    // No secret read port: the fake orchestrator will receive a separate task-scoped injection port.
    clear() {
      sessions.clear();
      devices.clear();
      grants.clear();
      secrets.clear();
    },
  });
}
