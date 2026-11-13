import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { startAccountBroker } from "./broker.js";
import { accountBrokerClient } from "./broker-client.js";

it("writes keys and device metadata through a session-bound native broker without returning or persisting key bytes", async () => {
  const root = await mkdtemp("/private/tmp/zoltbot-cloud-settings-"),
    origin = "https://accounts.example.invalid";
  const credentials = {
      sessionId: randomUUID(),
      accessToken: randomBytes(32).toString("base64url"),
      refreshToken: randomBytes(32).toString("base64url"),
    },
    providerKey = randomBytes(32).toString("base64url"),
    cellToken = randomBytes(32).toString("base64url"),
    deviceId = "d".repeat(22),
    publicKey = randomBytes(32).toString("base64url");
  let stored: unknown,
    requests = 0,
    echo = false;
  const broker = await startAccountBroker({
    origin,
    directory: path.join(root, "ipc"),
    referenceFile: path.join(root, "reference"),
    secrets: {
      async put(value) {
        stored = structuredClone(value);
        return { reference: "keychain:test-owner" };
      },
      async read() {
        return structuredClone(stored);
      },
      async replace(_reference, value) {
        stored = structuredClone(value);
      },
      async remove() {
        stored = undefined;
      },
    },
    async fetch(url, init) {
      requests++;
      const route = new URL(String(url)).pathname;
      expect(
        new Headers(init?.headers).get("authorization") === `Bearer ${credentials.accessToken}`,
      ).toBe(true);
      if (route === "/api/cloud/secrets/anthropic") {
        const input = JSON.parse(String(init?.body)) as { value: string };
        expect(input.value === providerKey).toBe(true);
        return Response.json(echo ? { ok: true, value: providerKey } : { ok: true });
      }
      if (route === "/api/cloud/cell-token")
        return Response.json({
          token: cellToken,
          cellUrl: "https://cell.example.invalid",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
      return Response.json({ ok: true });
    },
  });
  try {
    const control = accountBrokerClient({ origin, socketPath: broker.location() });
    await control.save(credentials);
    const client = accountBrokerClient({
      origin,
      socketPath: broker.location(),
      expectedSessionId: credentials.sessionId,
    });
    await client.status();
    expect(
      await client.cloudRequest(
        "/api/cloud/devices",
        "POST",
        JSON.stringify({ deviceId, publicKey }),
      ),
    ).toEqual({ ok: true });
    expect(
      await client.cloudRequest(
        "/api/cloud/secrets/anthropic",
        "PUT",
        JSON.stringify({ value: providerKey }),
      ),
    ).toEqual({ ok: true });
    const result = (await client.cloudRequest(
      "/api/cloud/cell-token",
      "POST",
      JSON.stringify({ orgId: "org", deviceId }),
    )) as { token: string };
    expect(result.token === cellToken).toBe(true);
    const devicesRoute = "/api/cloud/devices";
    expect(await client.cloudRequest(`${devicesRoute}/${deviceId}`, "DELETE")).toEqual({
      ok: true,
    });
    const count = requests;
    await expect(client.cloudRequest("/api/cloud/secrets/anthropic", "GET")).rejects.toThrow();
    await expect(
      client.cloudRequest("/api/cloud/secrets/anthropic", "PUT", "{broken"),
    ).rejects.toThrow();
    await expect(
      client.cloudRequest(
        "/api/cloud/devices",
        "POST",
        JSON.stringify({ deviceId, publicKey, extra: true }),
      ),
    ).rejects.toThrow();
    expect(requests).toBe(count);
    echo = true;
    await expect(
      client.cloudRequest(
        "/api/cloud/secrets/anthropic",
        "PUT",
        JSON.stringify({ value: providerKey }),
      ),
    ).rejects.toThrow("account_service_unavailable");
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(file);
        else if (entry.isFile()) {
          const bytes = await readFile(file);
          expect(
            [providerKey, cellToken, credentials.accessToken, credentials.refreshToken].some(
              (value) => bytes.includes(Buffer.from(value)),
            ),
          ).toBe(false);
        }
      }
    };
    await scan(root);
    await control.save({
      sessionId: randomUUID(),
      accessToken: randomBytes(32).toString("base64url"),
      refreshToken: randomBytes(32).toString("base64url"),
    });
    const beforeSwitchWrite = requests;
    await expect(
      client.cloudRequest(
        "/api/cloud/secrets/anthropic",
        "PUT",
        JSON.stringify({ value: providerKey }),
      ),
    ).rejects.toThrow("account_session_changed");
    expect(requests).toBe(beforeSwitchWrite);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});
