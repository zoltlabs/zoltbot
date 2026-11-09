import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { ConnectionRegistry } from "../../connections/src/registry.js";
import { connectionsApi } from "./connections-api.js";
import { PrivateInputGuard } from "./private-input.js";

it("protects stored access and refresh tokens before any native session after restart, without treating public resource metadata as a secret", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/connections-privacy-"));
  const store = await openStore(path.join(root, "test.db"));
  const reference = "keychain:zoltbot:00000000-0000-4000-8000-000000000000";
  const resource = "https://service.example/mcp";
  const credential = {
    resource,
    issuer: "https://issuer.example",
    accessToken: "SENTINEL_REBOOT_ACCESS",
    refreshToken: "SENTINEL_REBOOT_REFRESH",
  };
  const vault = { read: async () => credential, put: async () => ({ reference }) };
  try {
    new ConnectionRegistry(store.database).save(
      {
        id: "connection",
        name: "connection",
        version: 1,
        projectId: "project",
        transport: { kind: "https", url: resource },
        credentialReference: reference,
        schemaTokens: { value: 512, source: "estimated" },
        source: "manual",
        enabled: false,
        profileIds: [],
        credentialStatus: "connected",
        health: "not_checked",
      },
      0,
    );
    // A new guard has no in-memory remember() history, just as after daemon restart.
    const guard = new PrivateInputGuard({ store, secrets: vault, publish: () => {} });
    await expect(guard.prepareData({ text: credential.accessToken })).rejects.toThrow(
      "private_value_requires_secure_field",
    );
    await expect(guard.prepareData({ text: credential.refreshToken })).rejects.toThrow(
      "private_value_requires_secure_field",
    );
    const api = connectionsApi({ store, vault, checkPublic: (value) => guard.prepareData(value) });
    await expect(
      api.api(
        "connection.disable",
        { id: "connection", profileId: "profile" },
        credential.accessToken,
      ),
    ).rejects.toThrow("private_value_requires_secure_field");
    expect(store.receipt(credential.accessToken)).toBeUndefined();
    api.close();
    const safe = await guard.prepareData({ url: resource });
    expect(() => safe(store.snapshot())).not.toThrow();
    const noVault = new PrivateInputGuard({ store, publish: () => {} });
    await expect(noVault.prepareData({ text: "ordinary public metadata" })).rejects.toThrow(
      "runtime_credentials_unavailable",
    );
    expect(store.snapshot(["session"]).session ?? []).toEqual([]);
    expect(JSON.stringify(store.snapshot())).not.toContain(credential.accessToken);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
