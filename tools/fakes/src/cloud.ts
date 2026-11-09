/** Synthetic HTTP account fixture. Production authorization is tested against the real server. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ArtifactManifest,
  ArtifactManifestSchema,
  NativeStartSchema,
  parseCredentials,
  syntheticCredentials,
} from "@zoltbot/cloud-contracts";
import { parse } from "@zoltbot/protocol";

export function createCloudFake() {
  const credentials = {
    ...syntheticCredentials,
    sessionId: "11111111-1111-4111-8111-111111111111",
  };
  const intents = new Map<
    string,
    { redirectUri: string; state: string; challenge: string; code: string }
  >();
  const reservations = new Map<string, string>();
  const account = {
    sessionId: credentials.sessionId,
    user: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Example User",
      email: "user@example.test",
    },
    organizations: [
      { id: "22222222-2222-4222-8222-222222222222", name: "Example Organization", role: "owner" },
    ],
    sessions: [
      {
        id: credentials.sessionId,
        device_name: "Test device",
        surface: "desktop",
        last_seen_at: "2026-01-01T00:00:00Z",
      },
    ],
    capabilities: { privateArtifacts: true },
  };
  const artifacts = new Map<
    string,
    {
      id: string;
      title: string;
      manifest: unknown;
      manifestHash: string;
      visibility: string;
      uploaded: string[];
      state: string;
    }
  >();
  let signedIn = true;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const send = (value: unknown, status = 200) =>
      response.writeHead(status).end(JSON.stringify(value));
    const endpoint = request.url ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    let body: Record<string, unknown> = {};
    if (bytes.length && request.method !== "PUT") {
      try {
        const value: unknown = JSON.parse(bytes.toString());
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error("invalid_body");
        body = value as Record<string, unknown>;
      } catch {
        send({ error: "invalid_body" }, 400);
        return;
      }
    }
    if (endpoint === "/api/account/integrations/catalog") {
      send({ services: [] });
      return;
    }
    if (endpoint === "/api/account/native/start") {
      try {
        const input = parse(NativeStartSchema, body);
        const redirect = new URL(input.redirectUri);
        if (
          redirect.protocol !== "http:" ||
          redirect.hostname !== "127.0.0.1" ||
          redirect.pathname !== "/account/callback" ||
          redirect.username ||
          redirect.password ||
          redirect.search ||
          redirect.hash
        )
          throw Error("loopback_required");
        const id = randomUUID();
        intents.set(id, { ...input, code: randomBytes(32).toString("base64url") });
        send({
          intentId: id,
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/account/auth/google/start?intent=${id}`,
        });
      } catch {
        send({ error: "invalid_body" }, 400);
      }
      return;
    }
    if (endpoint.startsWith("/api/account/auth/google/start?")) {
      const intent = intents.get(
        new URL(endpoint, "http://127.0.0.1").searchParams.get("intent") ?? "",
      );
      if (!intent) {
        send({ error: "intent_unavailable" }, 404);
        return;
      }
      const redirect = new URL(intent.redirectUri);
      redirect.searchParams.set("state", intent.state);
      redirect.searchParams.set("code", intent.code);
      response.writeHead(303, { location: redirect.href }).end();
      return;
    }
    if (endpoint === "/api/account/native/redeem") {
      const found = [...intents.entries()].find(
        ([, intent]) =>
          intent.code === body.code &&
          intent.challenge ===
            createHash("sha256").update(String(body.verifier)).digest("base64url"),
      );
      if (!found) {
        send({ error: "handoff_unavailable" }, 401);
        return;
      }
      intents.delete(found[0]);
      signedIn = true;
      send(parseCredentials(credentials));
      return;
    }
    if (endpoint === "/api/account/session/refresh") {
      if (!signedIn || request.headers.authorization !== `Refresh ${credentials.refreshToken}`)
        send({ error: "sign_in_required" }, 401);
      else send(parseCredentials(credentials));
      return;
    }
    if (!signedIn || request.headers.authorization !== `Bearer ${credentials.accessToken}`) {
      send({ error: "sign_in_required" }, 401);
      return;
    }
    if (endpoint === "/api/account/me") {
      send(account);
      return;
    }
    if (endpoint === "/api/account/logout" || endpoint === "/api/account/sessions/revoke-all") {
      signedIn = false;
      send({ ok: true });
      return;
    }
    if (endpoint.startsWith("/api/account/sessions/") && request.method === "DELETE") {
      if (endpoint.endsWith(`/${credentials.sessionId}`)) signedIn = false;
      send({ ok: true });
      return;
    }
    if (endpoint === "/api/account/export") {
      send(account);
      return;
    }
    if (endpoint === "/api/account/artifacts") {
      if (request.method === "POST") {
        const existing = reservations.get(String(body.idempotencyKey));
        if (existing) {
          send(artifacts.get(existing));
          return;
        }
        let manifest: ArtifactManifest;
        try {
          manifest = parse(ArtifactManifestSchema, body.manifest);
        } catch {
          send({ error: "invalid_manifest" }, 400);
          return;
        }
        const artifact = {
          id: randomUUID(),
          title: String(body.title),
          manifest,
          manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
          visibility: "private",
          uploaded: [] as string[],
          state: "uploading",
        };
        artifacts.set(artifact.id, artifact);
        reservations.set(String(body.idempotencyKey), artifact.id);
        send(artifact, 201);
      } else send({ artifacts: [...artifacts.values()] });
      return;
    }
    const match =
      /^\/api\/account\/artifacts\/([^/]+)\/(view|commit|visibility|blobs\/([a-f0-9]+))$/.exec(
        endpoint,
      );
    const artifact = match && artifacts.get(match[1] ?? "");
    if (artifact && match) {
      if (match[2] === "commit") artifact.state = "ready";
      if (match[2] === "visibility") artifact.visibility = String(body.visibility);
      if (match[3]) artifact.uploaded.push(match[3]);
      send(artifact);
      return;
    }
    send({ error: "not_found" }, 404);
  });
  return server;
}
