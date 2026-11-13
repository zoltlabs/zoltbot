import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Credentials } from "@zoltbot/cloud-contracts";
import { expect, it } from "vitest";
import { runnerAccount } from "../cloud-runner/account.js";
import { RunnerAccessRevokedError } from "../cloud-runner/connection.js";
import { startAccountBroker } from "./broker.js";
import { accountBrokerClient } from "./broker-client.js";
import { brokerRunnerRequest } from "./runner.js";

it("gets a runner token and pinned public device keys through the single native refresh owner", async () => {
  const root = await mkdtemp("/private/tmp/zoltbot-runner-account-");
  const initial: Credentials = {
    sessionId: randomUUID(),
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
  };
  const rotated = {
    ...initial,
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
  };
  const runnerToken = randomBytes(32).toString("base64url"),
    deviceId = "device".padEnd(22, "x");
  let saved: unknown,
    refreshes = 0,
    requests = 0,
    denied = false;
  const broker = await startAccountBroker({
    origin: "https://accounts.example.invalid",
    directory: path.join(root, "ipc"),
    referenceFile: path.join(root, "reference"),
    secrets: {
      async put(value) {
        saved = structuredClone(value);
        return { reference: `keychain:zoltbot:${randomUUID()}` };
      },
      async read() {
        return structuredClone(saved);
      },
      async replace(_reference, value) {
        saved = structuredClone(value);
      },
      async remove() {
        saved = undefined;
      },
    },
    async fetch(url, init) {
      requests++;
      const route = new URL(String(url)).pathname;
      if (route.endsWith("/session/refresh")) {
        refreshes++;
        return Response.json(rotated);
      }
      if (new Headers(init?.headers).get("authorization") === `Bearer ${initial.accessToken}`)
        return new Response(null, { status: 401 });
      if (denied) return Response.json({ error: "Refused" }, { status: 403 });
      if (route === "/api/cloud/runner-token")
        return Response.json({
          token: runnerToken,
          cellUrl: "https://cell.example.invalid",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        });
      if (route === "/api/cloud/devices") return Response.json({ devices: [] });
      if (route === "/api/account/me") return Response.json({ ok: true });
      throw new Error("unexpected_fixture_route");
    },
  });
  try {
    const native = accountBrokerClient({
      origin: "https://accounts.example.invalid",
      socketPath: broker.location(),
    });
    await native.save(initial);
    const account = runnerAccount({
      origin: "https://accounts.example.invalid",
      orgId: "org",
      deviceId,
      nativeRequest: brokerRunnerRequest(native),
    });
    const [token, keys, metadata] = await Promise.all([
      account.credentials(new AbortController().signal),
      account.deviceKeys(new AbortController().signal),
      native.request("/me"),
    ]);
    expect(token.token === runnerToken).toBe(true);
    expect(keys).toEqual([]);
    expect(metadata).toEqual({ ok: true });
    expect(refreshes).toBe(1);
    const count = requests;
    await expect(native.cloudRequest("/api/cloud/devices", "POST")).rejects.toThrow();
    const canceled = new AbortController();
    canceled.abort();
    await expect(account.credentials(canceled.signal)).rejects.toThrow(
      "runner_account_unavailable",
    );
    expect(requests).toBe(count);
    denied = true;
    await expect(account.credentials(new AbortController().signal)).rejects.toBeInstanceOf(
      RunnerAccessRevokedError,
    );
    expect((await native.status()).signedIn).toBe(true);
    await native.save({ ...rotated, sessionId: randomUUID() });
    const beforeSwitchRequest = requests;
    await expect(account.credentials(new AbortController().signal)).rejects.toBeInstanceOf(
      RunnerAccessRevokedError,
    );
    expect(requests).toBe(beforeSwitchRequest);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});
