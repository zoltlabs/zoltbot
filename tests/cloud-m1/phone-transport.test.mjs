import { createHash, randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { phoneAccount, phoneAccountKey } from "../../apps/mobile/src/cloud/account.js";
import { phoneCloudConnection } from "../../apps/mobile/src/cloud/connection.js";
import { memoryStore } from "../../apps/mobile/src/data/link-store.js";
import { createIdentity, linkId, toB64 } from "../../packages/link/src/index.js";
import { cloudHarness } from "./harness.js";

it("uses the phone's native account for a real Cell socket and clears its projection on revocation", async () => {
  const harness = await cloudHarness("claude");
  const { account, fetch, proxy, tls } = harness;
  const origin = proxy.origin();
  const identity = createIdentity();
  const deviceId = linkId(identity.publicKey);
  const native = account.nativeSession({
    userId: "member",
    orgId: "personal",
    deviceId,
    surface: "phone",
  });
  const storage = memoryStore();
  await storage.set(phoneAccountKey, JSON.stringify({ version: 1, origin, credentials: native }));
  const phone = phoneAccount({
    origin,
    storage,
    deviceName: "Fixture phone",
    async randomBytes(size) {
      return randomBytes(size);
    },
    async challenge(verifier) {
      return createHash("sha256").update(verifier).digest("base64url");
    },
    browser: {
      async open() {
        throw new Error("fixture_browser_unavailable");
      },
      cancel() {},
    },
    fetch: (input, init) =>
      fetch(new URL(String(input)), {
        ...(init?.method ? { method: init.method } : {}),
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      }),
  });
  const credentials = vi.fn(() =>
    phone.cellConnection(native.sessionId, { orgId: "personal", deviceId }),
  );
  const connection = phoneCloudConnection({
    owner: { userId: "member", sessionId: native.sessionId, orgId: "personal", deviceId },
    credentials,
    socket(url, headers) {
      return new WebSocket(url, { ca: tls.certificate(), headers });
    },
  });
  try {
    await phone.registerDevice(native.sessionId, {
      deviceId,
      publicKey: toB64(identity.publicKey),
    });
    connection.start();
    await expect.poll(() => connection.state().status, { timeout: 10_000 }).toBe("online");
    expect(connection.state().snapshot.entities.project).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: harness.project.id })]),
    );
    const created = await connection.call(
      "cloud.project.create",
      {
        name: "Phone project",
        repository: "example/phone",
        defaultBranch: "main",
        setupScript: "",
      },
      "phone-transport-project",
    );
    await expect
      .poll(() =>
        connection.state().snapshot.entities.project?.some((row) => row.id === created.id),
      )
      .toBe(true);
    const response = await fetch(new URL("/api/account", origin), {
      method: "DELETE",
      headers: { authorization: `Bearer ${harness.session.accessToken}` },
      body: { confirm: "DELETE" },
    });
    expect(response.status).toBe(202);
    expect(await account.drainDeletions()).toBe(1);
    await expect.poll(() => connection.state().error).toBe("cloud_authority_refused");
    expect(connection.state().snapshot).toEqual({ seq: 0, entities: {}, counters: {} });
    await expect(connection.call("cloud.project.list", {})).rejects.toThrow("cloud_offline");
    expect(credentials).toHaveBeenCalledOnce();
    expect(harness.cell.refusedNetwork()).toBe(0);
  } finally {
    connection.stop();
    await harness.close();
  }
}, 30_000);
