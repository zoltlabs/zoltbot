import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { openStore } from "@zoltbot/store";
import { expect, it, vi } from "vitest";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { connectionsApi } from "./connections-api.js";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] }));

const fixture = vi.hoisted(() => ({ origin: "" }));
vi.mock("../../connections/src/recipes.js", async (original) => {
  const actual = await original<typeof import("../../connections/src/recipes.js")>();
  return {
    ...actual,
    recipeAuthorization: async (_service: string, resource: string, identity: string) => ({
      identity,
      resource,
      issuer: fixture.origin,
      clientId: "",
      registrationEndpoint: `${fixture.origin}/register`,
      authorizationEndpoint: `${fixture.origin}/authorize`,
      tokenEndpoint: `${fixture.origin}/token`,
      scopes: ["read"],
      policy: {
        origins: [fixture.origin, "https://mcp.linear.app"],
        localOrigins: [fixture.origin, "https://mcp.linear.app"],
      },
    }),
  };
});

it("completes catalog OAuth privately, requires access review on reconnect and removes stale completions", async () => {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/register") {
      const value = JSON.parse(body);
      res.writeHead(201).end(
        JSON.stringify({
          client_id: "public",
          token_endpoint_auth_method: "none",
          redirect_uris: value.redirect_uris,
        }),
      );
    } else
      res.end(
        JSON.stringify({
          access_token: "PRIVATE_CATALOG_TOKEN",
          token_type: "Bearer",
          scope: "read",
        }),
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  fixture.origin = `http://127.0.0.1:${address.port}`;
  mkdirSync(".cache/tests", { recursive: true });
  const directory = mkdtempSync(path.resolve(".cache/tests/catalog-auth-"));
  const store = await openStore(path.join(directory, "test.db"));
  const values = new Map<string, unknown>();
  const vault = {
    put: async (value: unknown) => {
      const reference = `keychain:zoltbot:${randomUUID()}`;
      values.set(reference, value);
      return { reference };
    },
    read: async (reference: string) => values.get(reference),
    remove: async (reference: string) => {
      values.delete(reference);
    },
  };
  const service = connectionsApi({ store, vault });
  const registry = new ConnectionRegistry(store.database);
  const call = (method: string, params: Record<string, unknown>) =>
    service.api(method, params, randomUUID());
  const insert = store.database.prepare(
    "INSERT INTO projection_records(kind,id,body) VALUES(?,?,?)",
  );
  insert.run("project", "project", JSON.stringify({ id: "project", roots: [] }));
  insert.run("agent", "profile", JSON.stringify({ id: "profile" }));
  const complete = async (authorizationUrl: string) => {
    const url = new URL(authorizationUrl);
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
    callback.search = new URLSearchParams({
      code: "code",
      state: url.searchParams.get("state") ?? "",
      iss: fixture.origin,
    }).toString();
    await fetch(callback);
  };
  try {
    const installed = (await call("connection.install", {
      serviceId: "linear",
      projectId: "project",
    })) as { id: string };
    const first = (await call("connection.auth.start", { id: installed.id, confirmed: true })) as {
      id: string;
      authorizationUrl: string;
    };
    await complete(first.authorizationUrl);
    await vi.waitFor(async () =>
      expect(await call("connection.auth.status", { id: first.id })).toEqual({
        state: "connected",
      }),
    );
    const connected = registry.get(installed.id);
    expect(connected).toMatchObject({
      enabled: false,
      profileIds: [],
      credentialStatus: "connected",
    });
    expect(values.size).toBe(1);
    expect(JSON.stringify(store.snapshot())).not.toContain("PRIVATE_CATALOG_TOKEN");
    await call("connection.save", {
      value: { ...connected, enabled: true, profileIds: ["profile"] },
      expectedVersion: connected.version,
      confirmed: true,
    });
    const reconnect = (await call("connection.auth.start", {
      id: installed.id,
      confirmed: true,
    })) as { id: string; authorizationUrl: string };
    await complete(reconnect.authorizationUrl);
    await vi.waitFor(async () =>
      expect(await call("connection.auth.status", { id: reconnect.id })).toEqual({
        state: "connected",
      }),
    );
    expect(registry.get(installed.id)).toMatchObject({ enabled: false, profileIds: [] });
    expect(registry.get(installed.id).credentialReference).not.toBe(connected.credentialReference);
    const stale = (await call("connection.auth.start", { id: installed.id, confirmed: true })) as {
      id: string;
      authorizationUrl: string;
    };
    const current = registry.get(installed.id);
    registry.save({ ...current, health: "unavailable" }, current.version);
    const count = values.size;
    await complete(stale.authorizationUrl);
    await vi.waitFor(async () =>
      expect(await call("connection.auth.status", { id: stale.id })).toEqual({ state: "failed" }),
    );
    expect(values.size).toBe(count);
  } finally {
    service.close();
    store.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});
