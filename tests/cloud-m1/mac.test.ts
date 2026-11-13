import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, it } from "vitest";
import { createIdentity, linkId, toB64 } from "../../packages/link/src/index.js";
import { createCloudFake } from "../../tools/fakes/src/cloud.js";
import { createCloudM1Account } from "../../tools/fakes/src/cloud-m1-account.js";
import { startTestCell } from "./cell.js";
import { loopbackClient } from "./client.js";
import { startTestMac } from "./mac.js";
import { startTlsProxy } from "./proxy.js";
import { loopbackTls } from "./tls.js";

it("starts a headless daemon with a private account broker and connects its opted-in Mac runner to the real Cell", async () => {
  const root = await mkdtemp("/private/tmp/zoltbot-m1-mac-");
  let cell: Awaited<ReturnType<typeof startTestCell>> | undefined,
    mac: Awaited<ReturnType<typeof startTestMac>> | undefined,
    globalOrigin: string | undefined;
  const tls = await loopbackTls();
  const proxy = await startTlsProxy(tls, (pathname) =>
    pathname.startsWith("/api/")
      ? globalOrigin
        ? new URL(globalOrigin)
        : undefined
      : cell
        ? new URL(cell.origin())
        : undefined,
  );
  const serviceKey = randomBytes(32).toString("base64url");
  const account = await createCloudM1Account({
    issuer: proxy.origin(),
    cellUrl: proxy.origin(),
    serviceKey,
  });
  const global = createCloudFake({ cloud: (request) => account.handle(request) });
  await new Promise<void>((resolve) => global.listen(0, "127.0.0.1", resolve));
  globalOrigin = `http://127.0.0.1:${(global.address() as AddressInfo).port}`;
  try {
    const jwks = new URL("/api/cloud/jwks.json", globalOrigin);
    cell = await startTestCell({
      directory: path.join(root, "cell"),
      issuer: proxy.origin(),
      jwksUrl: jwks.href,
      orchestratorUrl: new URL(".", jwks).href,
      serviceKey,
    });
    const identity = createIdentity(),
      deviceId = linkId(identity.publicKey);
    const credentials = account.nativeSession({
      userId: "member",
      orgId: "personal",
      deviceId,
      surface: "desktop",
    });
    const fetch = loopbackClient(tls.certificate());
    expect(
      (
        await fetch(new URL("/api/cloud/devices", proxy.origin()), {
          headers: { authorization: `Bearer ${credentials.accessToken}` },
          body: { deviceId, publicKey: toB64(identity.publicKey) },
        })
      ).status,
    ).toBe(200);
    const directory = path.join(root, "mac");
    mac = await startTestMac({
      directory,
      origin: proxy.origin(),
      orgId: "personal",
      memberId: "member",
      deviceId,
      taskId: "owned-task",
      credentials,
      tls,
    });
    await expect
      .poll(() => mac?.statuses().includes("runner_connected"), { timeout: 10000 })
      .toBe(true);
    expect(mac.statuses()).not.toContain("runner_access_revoked");
    await mac.close();
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(file);
        else if (entry.isFile()) {
          const bytes = await readFile(file);
          for (const value of [credentials.accessToken, credentials.refreshToken, serviceKey])
            expect(bytes.includes(Buffer.from(value))).toBe(false);
        }
      }
    };
    await scan(directory);
    expect(cell.refusedNetwork()).toBe(0);
  } finally {
    await mac?.close();
    await cell?.close();
    account.clear();
    await proxy.close();
    global.closeAllConnections();
    await new Promise<void>((resolve) => global.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 45000);
