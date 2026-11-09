import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { connectionsApi } from "./connections-api.js";
import { KeychainSecrets } from "./secrets.js";

it("enforces profile and local execution approval, blocks credential forgery and deletes a disconnected credential", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const directory = mkdtempSync(path.resolve(".cache/tests/connections-api-"));
  const store = await openStore(path.join(directory, "test.db"));
  const values = new Map<string, string>();
  const vault = new KeychainSecrets(async (request) => {
    if (request.op === "put") {
      values.set(request.account, request.value ?? "");
      return { ok: true };
    }
    if (request.op === "remove") {
      values.delete(request.account);
      return { ok: true };
    }
    return { ok: true, value: values.get(request.account), found: values.has(request.account) };
  });
  let changes = 0;
  const published: unknown[] = [];
  const service = connectionsApi({
    store,
    vault,
    onChanged: () => {
      changes++;
    },
    publish: (events) => published.push(...events),
  });
  const call = (method: string, params: Record<string, unknown>) =>
    service.api(method, params, randomUUID());
  const put = store.database.prepare("INSERT INTO projection_records(kind,id,body) VALUES(?,?,?)");
  put.run("project", "project", JSON.stringify({ id: "project", roots: [] }));
  put.run("agent", "profile", JSON.stringify({ id: "profile" }));
  const value = {
    id: "local",
    name: "local",
    version: 1,
    projectId: "project",
    transport: { kind: "stdio", command: "/usr/bin/true", args: [] },
    enabled: true,
    profileIds: ["profile"],
    source: "manual",
    credentialStatus: "not_required",
    health: "not_checked",
    schemaTokens: { value: 512, source: "estimated" },
  };
  try {
    await expect(
      call("connection.save", { value, expectedVersion: 0, confirmed: true }),
    ).rejects.toThrow("execution_confirmation_required");
    await expect(
      call("connection.save", {
        value: {
          ...value,
          transport: { kind: "https", url: "https://service.example/mcp" },
          credentialStatus: "connected",
          credentialReference: "forged",
        },
        expectedVersion: 0,
        confirmed: true,
      }),
    ).rejects.toThrow("sign_in_required");
    await expect(
      call("connection.save", {
        value,
        expectedVersion: 0,
        confirmed: true,
        executionConfirmed: true,
      }),
    ).resolves.toMatchObject({ enabled: true, executionApproved: true });
    expect(changes).toBe(1);
    expect(published).toHaveLength(1);
    expect(
      store.snapshot(["settings"]).settings?.some((row) => row.key === "connections.revision"),
    ).toBe(true);
    const retryId = randomUUID();
    await service.api("connection.disable", { id: "local", profileId: "unused" }, retryId);
    const sequence = store.lastSeq();
    await service.api("connection.disable", { id: "local", profileId: "unused" }, retryId);
    expect(store.lastSeq()).toBe(sequence);
    expect(changes).toBe(2);
    const credential = await vault.put({ accessToken: "SENTINEL_PRIMARY_CREDENTIAL" });
    // Private auth completes behind the API and attaches only an opaque reference.
    const body = store.database
      .prepare("SELECT body FROM connections_aux WHERE id='local'")
      .get() as { body: string };
    store.database.prepare("UPDATE connections_aux SET body=? WHERE id='local'").run(
      JSON.stringify({
        ...JSON.parse(body.body),
        credentialReference: credential.reference,
        credentialStatus: "connected",
      }),
    );
    await expect(
      call("connection.disconnect", {
        id: "local",
        confirmed: true,
        stopSessions: true,
        expectedVersion: JSON.parse(body.body).version,
        expectedSessionIds: ["unreviewed-session"],
      }),
    ).rejects.toThrow("connection_disconnect_changed");
    expect(await vault.exists(credential.reference)).toBe(true);
    await expect(
      call("connection.disconnect", {
        id: "local",
        confirmed: true,
        stopSessions: false,
        expectedVersion: JSON.parse(body.body).version,
        expectedSessionIds: [],
      }),
    ).resolves.toEqual({ ok: true });
    expect(await vault.exists(credential.reference)).toBe(false);
    expect(values.size).toBe(0);
    expect(JSON.stringify(await call("connection.list", {}))).not.toContain(
      "SENTINEL_PRIMARY_CREDENTIAL",
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("installs curated apps disabled, preserves command retries and rejects forged catalog resources", async () => {
  const directory = mkdtempSync(path.resolve(".cache/tests/catalog-api-"));
  const store = await openStore(path.join(directory, "test.db"));
  store.database
    .prepare("INSERT INTO projection_records(kind,id,body) VALUES(?,?,?)")
    .run("project", "project", JSON.stringify({ id: "project", roots: [] }));
  const service = connectionsApi({ store, catalogStatus: async () => [] });
  try {
    const catalog = (await service.api("connection.catalog.list", {})) as {
      items: { id: string }[];
    };
    expect(catalog.items.map((c) => c.id)).toEqual([
      "linear",
      "sentry",
      "posthog",
      "github",
      "gmail",
      "google_drive",
      "google_docs",
      "slack",
    ]);
    expect(catalog.items.find((c) => c.id === "github")).toMatchObject({
      availability: "registration_required",
    });
    const posthog = (await service.api(
      "connection.install",
      { serviceId: "posthog", projectId: "project", serviceProject: "123" },
      randomUUID(),
    )) as Record<string, unknown>;
    expect(posthog).toMatchObject({ posthog: { projectId: "123" }, enabled: false });
    await expect(
      service.api(
        "connection.save",
        {
          value: { ...posthog, posthog: { projectId: "999" } },
          expectedVersion: 1,
          confirmed: true,
        },
        randomUUID(),
      ),
    ).rejects.toThrow("resource_immutable");
    const params = {
      serviceId: "sentry",
      projectId: "project",
      organization: "example",
      serviceProject: "web",
    };
    const command = randomUUID();
    const installed = (await service.api("connection.install", params, command)) as Record<
      string,
      unknown
    >;
    expect(installed).toMatchObject({
      enabled: false,
      profileIds: [],
      source: "catalog:sentry:v1",
      credentialStatus: "needs_sign_in",
      transport: { url: "https://mcp.sentry.dev/mcp/example/web" },
    });
    expect(await service.api("connection.install", params, command)).toEqual(installed);
    await expect(
      service.api("connection.install", { ...params, organization: "../other" }, randomUUID()),
    ).rejects.toThrow("project_required");
    await expect(
      service.api("connection.install", { ...params, projectId: "missing" }, randomUUID()),
    ).rejects.toThrow("scope_denied");
    await expect(
      service.api(
        "connection.save",
        {
          value: { ...installed, transport: { kind: "https", url: "https://mcp.sentry.dev/mcp" } },
          expectedVersion: 1,
          confirmed: true,
        },
        randomUUID(),
      ),
    ).rejects.toThrow("resource_immutable");
    await expect(
      service.api(
        "connection.save",
        { value: { ...installed, enabled: true }, expectedVersion: 1, confirmed: true },
        randomUUID(),
      ),
    ).rejects.toThrow("sign_in_required");
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
