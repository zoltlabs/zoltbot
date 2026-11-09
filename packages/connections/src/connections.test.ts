import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { composeLaunchManifest } from "./launch-manifest.js";
import { LaunchManifestStore } from "./manifest-store.js";
import { resolveConnections } from "./materialize.js";
import { checkedDestination, requestJson } from "./network.js";
import { ConnectionOAuth } from "./oauth.js";
import { type ConnectionRecord, ConnectionRegistry } from "./registry.js";

const connection: ConnectionRecord = {
  id: "linear",
  name: "linear",
  version: 1,
  projectId: "project-a",
  transport: { kind: "https", url: "https://mcp.example.com/mcp" },
  schemaTokens: { value: 256, source: "estimated" },
  source: "manual",
  enabled: false,
  profileIds: [],
  credentialStatus: "not_required",
  health: "not_checked",
};
function database() {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("../007-connections.sql", import.meta.url), "utf8"));
  return db;
}
const identity = {
  executionId: "execution",
  threadId: "thread",
  projectId: "project-a",
  profileId: "profile-a",
  cwd: "/work",
  configurationHash: "hash",
};
describe("connections isolation and frozen launch", () => {
  it("defaults disabled and intersects project/profile/capability; access widening needs confirmation", () => {
    const db = database(),
      registry = new ConnectionRegistry(db);
    registry.save(connection, 0);
    expect(registry.effective("project-a", "profile-a", true)).toEqual([]);
    expect(() =>
      registry.save({ ...connection, enabled: true, profileIds: ["profile-a"] }, 1),
    ).toThrow("confirmation_required");
    registry.save({ ...connection, enabled: true, profileIds: ["profile-a"] }, 1, true);
    expect(registry.effective("project-a", "profile-a", true)).toHaveLength(1);
    expect(registry.effective("project-b", "profile-a", true)).toEqual([]);
    expect(registry.effective("project-a", "profile-b", true)).toEqual([]);
    expect(registry.effective("project-a", "profile-a", false)).toEqual([]);
    db.close();
  });
  it("retains a coherent manifest on retry and rolls back failed intent validation", () => {
    const db = database(),
      store = new LaunchManifestStore(db);
    const first = composeLaunchManifest(
      identity,
      { connections: [connection] },
      { limit: 1500, fixed: 100 },
    );
    expect(() =>
      store.prepare(first, () => {
        throw new Error("changed");
      }),
    ).toThrow("changed");
    expect(store.byExecution(identity.executionId)).toBeUndefined();
    store.prepare(first, () => {});
    const changed = composeLaunchManifest(identity, {}, { limit: 1500, fixed: 100 });
    expect(store.prepare(changed, () => {})).toEqual(first);
    store.bind(first.id, "native-1");
    expect(() => store.bind(first.id, "native-2")).toThrow("binding_conflict");
    expect(() =>
      composeLaunchManifest(
        identity,
        { connections: [connection], knowledge: { packId: "pack", text: "pinned", tokens: 1200 } },
        { limit: 1500, fixed: 100 },
      ),
    ).toThrow("context_budget_hold");
    db.close();
  });
  it("fails closed on credential deletion and binds the credential to the exact resource", async () => {
    const descriptor = {
      ...connection,
      credentialReference: "keychain:zoltbot:00000000-0000-4000-8000-000000000000",
    };
    await expect(
      resolveConnections(
        [descriptor],
        {
          read: async () => {
            throw new Error("missing");
          },
        },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("credentials_unavailable");
    await expect(
      resolveConnections(
        [descriptor],
        { read: async () => ({ resource: "https://other.example", accessToken: "secret" }) },
        () => {},
        () => {},
      ),
    ).rejects.toThrow("credentials_unavailable");
  });
  it("blocks private DNS destinations and credentials in URLs", async () => {
    await expect(
      checkedDestination("https://127.0.0.1/mcp", { origins: ["https://127.0.0.1"] }),
    ).rejects.toThrow("destination_denied");
    await expect(
      checkedDestination("https://user:secret@example.com", { origins: ["https://example.com"] }),
    ).rejects.toThrow("destination_denied");
  });
});
it("authenticates against a local fake issuer using PKCE and stores only a vault reference", async () => {
  const values: unknown[] = [];
  let verifier = "",
    resource = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const form = new URLSearchParams(body);
      verifier = form.get("code_verifier") ?? "";
      resource = form.get("resource") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          token_type: "Bearer",
          access_token: "sentinel-access",
          refresh_token: "sentinel-refresh",
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error();
  const origin = `http://127.0.0.1:${addr.port}`;
  const config = {
    identity: "test",
    issuer: origin,
    resource: `${origin}/mcp`,
    clientId: "test-client",
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    scopes: ["read"],
    policy: { origins: [origin], localOrigins: [origin] },
  };
  const oauth = new ConnectionOAuth({
    put: async (value) => {
      values.push(value);
      return { reference: "keychain:zoltbot:test" };
    },
  });
  try {
    const pending = await oauth.start(config);
    const url = new URL(pending.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(url.searchParams.get("redirect_uri") as string);
    callback.search = new URLSearchParams({
      state: url.searchParams.get("state") as string,
      code: "one-use",
      iss: origin,
    }).toString();
    expect((await fetch(callback)).status).toBe(200);
    expect(await pending.result).toEqual({ reference: "keychain:zoltbot:test" });
    expect(verifier.length).toBeGreaterThan(40);
    expect(resource).toBe(config.resource);
    expect(values).toHaveLength(1);
    const cancelled = await oauth.start(config);
    cancelled.cancel();
    await expect(cancelled.result).rejects.toThrow("oauth_cancelled");
    const mismatch = await oauth.start(config);
    const bad = new URL(
      new URL(mismatch.authorizationUrl).searchParams.get("redirect_uri") as string,
    );
    bad.search = "state=incorrect&code=stolen";
    expect((await fetch(bad)).status).toBe(400);
    await expect(mismatch.result).rejects.toThrow("callback_rejected");
    expect(values).toHaveLength(1);
    await expect(requestJson(`${origin}/redirect`, { origins: [] })).rejects.toThrow(
      "destination_denied",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("rejects redirects without fetching the target and times out pending sign-in without vault writes", async () => {
  let writes = 0,
    redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === "/target") redirected++;
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const origin = `http://127.0.0.1:${address.port}`;
  const policy = { origins: [origin], localOrigins: [origin] };
  const config = {
    identity: "timeout",
    issuer: origin,
    resource: `${origin}/mcp`,
    clientId: "test",
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    scopes: [],
    policy,
  };
  try {
    await expect(requestJson(`${origin}/redirect`, policy)).rejects.toThrow("request_failed");
    expect(redirected).toBe(0);
    const oauth = new ConnectionOAuth({
      put: async () => {
        writes++;
        return { reference: "never" };
      },
    });
    const pending = await oauth.start(config, 10);
    await expect(pending.result).rejects.toThrow("oauth_timeout");
    expect(writes).toBe(0);
    await expect(
      oauth.refresh(config, {
        issuer: "other",
        resource: config.resource,
        accessToken: "x",
        refreshToken: "r",
      }),
    ).rejects.toThrow("binding_mismatch");
    await expect(
      oauth.refresh(config, {
        issuer: config.issuer,
        resource: config.resource,
        accessToken: "x",
        refreshToken: "r",
      }),
    ).rejects.toThrow("refresh_failed");
    expect(writes).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("records observed health without changing frozen descriptor versions or access", () => {
  const db = database(),
    registry = new ConnectionRegistry(db);
  try {
    const saved = registry.save(connection, 0);
    registry.recordHealth(saved.id, saved.version, "healthy", "2026-11-06T00:00:00.000Z");
    expect(registry.get(saved.id)).toMatchObject({
      version: saved.version,
      enabled: false,
      health: "healthy",
    });
    expect(() =>
      registry.recordHealth(saved.id, 99, "unavailable", "2026-11-06T00:00:00.000Z"),
    ).toThrow("version_conflict");
  } finally {
    db.close();
  }
});

it("freezes PostHog project/read-only headers and rejects constraint injection on other hosts", async () => {
  const db = database(),
    registry = new ConnectionRegistry(db);
  const value = {
    ...connection,
    id: "posthog",
    name: "posthog",
    source: "catalog:posthog:v1",
    transport: { kind: "https" as const, url: "https://mcp.posthog.com/mcp" },
    posthog: { projectId: "123" },
  };
  try {
    registry.save({ ...value, enabled: true, profileIds: ["profile-a"] }, 0, true);
    const descriptors = registry.effective("project-a", "profile-a", true);
    expect(descriptors[0]?.posthog).toEqual({ projectId: "123" });
    const native = await resolveConnections(
      descriptors,
      { read: async () => undefined },
      () => {},
      () => {},
    );
    expect(native[0]).toMatchObject({
      headers: {
        "x-posthog-project-id": "123",
        "x-posthog-read-only": "true",
        "x-posthog-mcp-mode": "cli",
      },
    });
    expect(() =>
      registry.save(
        { ...value, id: "other", transport: { kind: "https", url: "https://other.test/mcp" } },
        0,
      ),
    ).toThrow("posthog_project_invalid");
  } finally {
    db.close();
  }
});
