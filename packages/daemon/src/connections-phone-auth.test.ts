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
      clientId: "zoltbot-desktop",
      authorizationEndpoint: `${fixture.origin}/authorize`,
      tokenEndpoint: `${fixture.origin}/token`,
      scopes: ["read"],
      policy: {
        origins: [fixture.origin, new URL(resource).origin],
        localOrigins: [fixture.origin, new URL(resource).origin],
      },
    }),
  };
});

// P10: signing in to a broker app from the phone. The redirect comes back to the phone app,
// which passes it to the Mac with connection.auth.finish.
it("finishes a phone sign-in on the Mac and keeps other apps on the Mac", async () => {
  let redirect = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    redirect = new URLSearchParams(body).get("redirect_uri") ?? "";
    res.end(
      JSON.stringify({ access_token: "PRIVATE_PHONE_TOKEN", token_type: "Bearer", scope: "read" }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error();
  fixture.origin = `http://127.0.0.1:${address.port}`;
  mkdirSync(".cache/tests", { recursive: true });
  const directory = mkdtempSync(path.resolve(".cache/tests/phone-auth-"));
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
  const service = connectionsApi({ store, vault, catalogStatus: async () => ["gmail"] });
  const registry = new ConnectionRegistry(store.database);
  const call = (method: string, params: Record<string, unknown>) =>
    service.api(method, params, randomUUID());
  store.database
    .prepare("INSERT INTO projection_records(kind,id,body) VALUES(?,?,?)")
    .run("project", "project", JSON.stringify({ id: "project", roots: [] }));
  try {
    const catalog = (await call("connection.catalog.list", {})) as {
      items: { id: string; phoneSignIn?: boolean }[];
    };
    expect(catalog.items.find((item) => item.id === "gmail")?.phoneSignIn).toBe(true);
    expect(catalog.items.find((item) => item.id === "linear")?.phoneSignIn).toBe(false);

    const linear = (await call("connection.install", {
      serviceId: "linear",
      projectId: "project",
    })) as { id: string };
    await expect(
      call("connection.auth.startForPhone", { id: linear.id, confirmed: true }),
    ).rejects.toThrow("oauth_phone_unsupported");

    const gmail = (await call("connection.install", {
      serviceId: "gmail",
      projectId: "project",
    })) as { id: string };
    const start = async () => {
      const attempt = (await call("connection.auth.startForPhone", {
        id: gmail.id,
        confirmed: true,
      })) as { id: string; authorizationUrl: string };
      const url = new URL(attempt.authorizationUrl);
      expect(url.searchParams.get("redirect_uri")).toBe("zoltbot://connection-done");
      return { id: attempt.id, state: url.searchParams.get("state") ?? "" };
    };
    // A redirect from another sign-in fails this one without a token exchange.
    const wrong = await start();
    await expect(
      call("connection.auth.finish", { id: wrong.id, state: "other", code: "code" }),
    ).rejects.toThrow("oauth_callback_rejected");
    await vi.waitFor(async () =>
      expect(await call("connection.auth.status", { id: wrong.id })).toEqual({ state: "failed" }),
    );
    expect(values.size).toBe(0);

    const right = await start();
    await call("connection.auth.finish", {
      id: right.id,
      state: right.state,
      code: "code",
      iss: fixture.origin,
    });
    await vi.waitFor(async () =>
      expect(await call("connection.auth.status", { id: right.id })).toEqual({
        state: "connected",
      }),
    );
    expect(redirect).toBe("zoltbot://connection-done");
    expect(registry.get(gmail.id)).toMatchObject({ credentialStatus: "connected", enabled: false });
    expect(JSON.stringify(store.snapshot())).not.toContain("PRIVATE_PHONE_TOKEN");

    // A Mac sign-in can't be finished from the phone.
    const mac = (await call("connection.auth.start", { id: gmail.id, confirmed: true })) as {
      id: string;
    };
    await expect(
      call("connection.auth.finish", { id: mac.id, state: "x", code: "code" }),
    ).rejects.toThrow("oauth_attempt_not_found");
    await call("connection.auth.cancel", { id: mac.id });
  } finally {
    service.close();
    store.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  }
});
