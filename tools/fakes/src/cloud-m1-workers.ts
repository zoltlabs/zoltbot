import { createHash, randomBytes } from "node:crypto";
import {
  CellJwksSchema,
  CellTokenClaimsSchema,
  WorkerTokenRequestSchema,
} from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";
import { verifyServiceToken } from "../../../packages/cell/src/service.js";
import { createCellIdentity } from "./cell-identity.js";
import type { createCloudM1Account, FakeAccountRequest } from "./cloud-m1-account.js";

interface Scope {
  orgId: string;
  userId: string;
  taskId: string;
  runnerId: string;
}
interface Grant extends Scope {
  refreshHash: string;
  active: boolean;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (scope: Pick<Scope, "orgId" | "taskId">) => JSON.stringify([scope.orgId, scope.taskId]);

/** Sandbox authority for the localhost harness. The fake orchestrator alone calls provision. */
export async function createCloudM1Workers(options: {
  issuer: string;
  cellUrl: string;
  serviceKey: string;
  account: Pick<Awaited<ReturnType<typeof createCloudM1Account>>, "handle">;
}) {
  const { issuer, cellUrl, serviceKey, account } = options;
  const identity = await createCellIdentity({ issuer }),
    grants = new Map<string, Grant>();
  const token = async (scope: Scope) => {
    const signed = await identity.issue({
      org: scope.orgId,
      sub: scope.userId,
      task: scope.taskId,
      device: scope.runnerId,
      kind: "sandbox_runner",
      surface: "runner",
    });
    const payload = signed.split(".")[1];
    if (!payload) throw new Error("fixture_worker_scope_invalid");
    const claims = parse(
      CellTokenClaimsSchema,
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return { token: signed, cellUrl, expiresAt: new Date(claims.exp * 1000).toISOString() };
  };
  return Object.freeze({
    async provision(scope: Scope) {
      if (
        Object.keys(scope).sort().join(",") !== "orgId,runnerId,taskId,userId" ||
        Object.values(scope).some(
          (value) => typeof value !== "string" || !value || value.length > 200,
        )
      )
        throw new Error("fixture_worker_scope_invalid");
      const refresh = randomBytes(32).toString("base64url");
      grants.set(id(scope), { ...scope, refreshHash: hash(refresh), active: true });
      return { ...(await token(scope)), refresh };
    },
    async handle(request: FakeAccountRequest) {
      try {
        if (request.path === "/api/cloud/jwks.json" && request.method === "GET") {
          const current = await account.handle(request);
          const publicKeys = parse(CellJwksSchema, current?.body);
          return { status: 200, body: { keys: [...publicKeys.keys, ...identity.jwks().keys] } };
        }
        if (request.path === "/api/cloud/worker-token" && request.method === "POST") {
          const input = parse(WorkerTokenRequestSchema, request.body);
          const refresh = /^Worker ([A-Za-z0-9_-]{43})$/.exec(request.authorization ?? "")?.[1];
          const grant = grants.get(id(input));
          if (
            !refresh ||
            !grant?.active ||
            grant.refreshHash !== hash(refresh) ||
            grant.runnerId !== input.runnerId
          )
            return { status: 403, body: { error: "forbidden" } };
          return { status: 200, body: await token(grant) };
        }
        const input = request.body as Record<string, unknown> | null;
        if (
          request.path === "/api/cloud/access" &&
          request.method === "POST" &&
          input?.kind === "sandbox_runner"
        ) {
          if (
            Object.keys(input).some(
              (name) =>
                !["orgId", "userId", "deviceId", "taskId", "kind", "surface", "tokenId"].includes(
                  name,
                ),
            ) ||
            ["orgId", "userId", "deviceId", "taskId", "tokenId"].some(
              (name) => typeof input[name] !== "string" || !input[name],
            ) ||
            input.surface !== "runner"
          )
            return { status: 403, body: { active: false } };
          const orgId = String(input.orgId),
            taskId = String(input.taskId);
          const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.authorization ?? "")?.[1] ?? "";
          await verifyServiceToken(bearer, serviceKey, issuer, "orchestrator", orgId);
          const grant = grants.get(id({ orgId, taskId }));
          return {
            status: 200,
            body: {
              active:
                !!grant?.active &&
                grant.userId === input.userId &&
                grant.runnerId === input.deviceId,
            },
          };
        }
        return await account.handle(request);
      } catch {
        return { status: 400, body: { error: "fixture_request_refused" } };
      }
    },
    revoke(orgId: string, taskId: string) {
      const grant = grants.get(id({ orgId, taskId }));
      if (grant) grant.active = false;
    },
    clearOrg(orgId: string) {
      for (const [key, grant] of grants) if (grant.orgId === orgId) grants.delete(key);
    },
  });
}
