import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import type { OAuthConfiguration, OAuthCredential } from "../../connections/src/oauth.js";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { connectionsRuntime } from "./connections-runtime.js";
import { Redactor } from "./logging.js";
import { KeychainSecrets } from "./secrets.js";

it("serializes refresh rotation into the same vault reference and fails closed without replacing a rejected grant", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/connections-refresh-"));
  let requests = 0,
    rejectRefresh = false;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => {
      body += part;
    });
    req.on("end", () => {
      requests++;
      const form = new URLSearchParams(body);
      if (
        rejectRefresh ||
        form.get("grant_type") !== "refresh_token" ||
        !form.get("refresh_token")
      ) {
        res.writeHead(400).end("SENTINEL_PRIVATE_REFRESH_FAILURE");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          token_type: "Bearer",
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      );
    });
  });
  await new Promise<void>((yes, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", yes);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  const origin = `http://127.0.0.1:${address.port}`,
    resource = "https://service.example/mcp";
  const registration: OAuthConfiguration = {
    identity: "connection",
    issuer: origin,
    resource,
    clientId: "public-client",
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    scopes: ["read"],
    policy: { origins: [origin, "https://service.example"], localOrigins: [origin] },
  };
  const values = new Map<string, string>();
  let replacements = 0,
    puts = 0;
  const vault = new KeychainSecrets(async (input) => {
    if (input.op === "put") {
      puts++;
      values.set(input.account, input.value ?? "");
      return { ok: true };
    }
    if (input.op === "replace") {
      if (!values.has(input.account)) return { ok: false };
      replacements++;
      values.set(input.account, input.value ?? "");
      return { ok: true };
    }
    return { ok: true, value: values.get(input.account) };
  });
  const store = await openStore(path.join(root, "test.db"));
  try {
    const grant: OAuthCredential = {
      issuer: origin,
      resource,
      registration,
      accessToken: "expired-access",
      refreshToken: "original-refresh",
      expiresAt: Date.now() - 1,
    };
    const { reference } = await vault.put(grant);
    const registry = new ConnectionRegistry(store.database);
    registry.save(
      {
        id: "connection",
        name: "connection",
        projectId: "project",
        version: 1,
        transport: { kind: "https", url: resource },
        credentialReference: reference,
        schemaTokens: { value: 512, source: "estimated" },
        source: "manual",
        enabled: true,
        profileIds: ["profile"],
        credentialStatus: "connected",
        health: "not_checked",
      },
      0,
      true,
    );
    const service = connectionsRuntime(store, vault);
    const manifest = service.compose(
      {
        threadId: "thread",
        profileId: "profile",
        projectId: "project",
        cwd: root,
        configuration: {},
        fixed: 0,
      },
      { connections: registry.effective("project", "profile", true) },
    );
    const redactor = new Redactor();
    const [one, two] = await Promise.all([
      service.resolve(manifest, redactor),
      service.resolve(manifest, redactor),
    ]);
    expect(one).toEqual(two);
    expect(one[0]).toMatchObject({ headers: { Authorization: "Bearer rotated-access" } });
    expect(requests).toBe(1);
    expect(puts).toBe(1);
    expect(replacements).toBe(1);
    expect(registry.get("connection").credentialReference).toBe(reference);
    expect(registry.get("connection").version).toBe(1);
    expect(await vault.read(reference)).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
    expect(redactor.text("rotated-access")).toBe("[redacted]");
    rejectRefresh = true;
    await vault.replace(reference, { ...grant, refreshToken: "invalid-refresh" });
    const before = replacements;
    await expect(service.resolve(manifest, new Redactor())).rejects.toThrow(
      "connection_credentials_unavailable",
    );
    expect(replacements).toBe(before);
    expect(await vault.read(reference)).toMatchObject({
      accessToken: "expired-access",
      refreshToken: "invalid-refresh",
    });
    expect(
      JSON.stringify(store.database.prepare("SELECT body FROM connections_aux").all()),
    ).not.toContain("rotated-access");
  } finally {
    store.close();
    server.closeAllConnections();
    await new Promise<void>((yes) => server.close(() => yes()));
    rmSync(root, { recursive: true, force: true });
  }
});
