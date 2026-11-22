import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { accountBrokerClient } from "../account-session/broker-client.js";
import { startDaemon } from "../api.js";
import type { MacRunnerOptions } from "./mac.js";

it("owns a separate cloud host lifetime without providing the Local store or runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-cloud-daemon-"));
  let starts = 0,
    closes = 0;
  const daemon = await startDaemon({
    dataDir: root,
    cloudRunner(input) {
      starts++;
      expect(Object.keys(input).sort()).toEqual(["dataDir", "status"]);
      expect(input.dataDir).toBe(path.join(root, "cloud"));
      return {
        async close() {
          closes++;
        },
      };
    },
  });
  try {
    expect(starts).toBe(1);
    expect(closes).toBe(0);
    await Promise.all([daemon.close(), daemon.close()]);
    expect(closes).toBe(1);
    const reopened = await startDaemon({ dataDir: root });
    await reopened.close();
    expect(starts).toBe(1);
    expect(closes).toBe(1);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("starts the native runner only for the configured session and closes it on logout", async () => {
  const root = await mkdtemp("/private/tmp/zolt-mac-start-");
  const credentials = {
    sessionId: randomUUID(),
    accessToken: randomBytes(32).toString("base64url"),
    refreshToken: randomBytes(32).toString("base64url"),
  };
  const origin = "https://example.invalid";
  const values = new Map<string, unknown>();
  const vault = {
    async put(value: unknown) {
      const reference = `keychain:${randomUUID()}`;
      values.set(reference, structuredClone(value));
      return { reference };
    },
    async read(reference: string) {
      return structuredClone(values.get(reference));
    },
    async replace(reference: string, value: unknown) {
      values.set(reference, structuredClone(value));
    },
    async remove(reference: string) {
      values.delete(reference);
    },
  };
  let accountReads = 0,
    runner: MacRunnerOptions | undefined,
    starts = 0,
    closes = 0;
  const daemon = await startDaemon({
    dataDir: root,
    secrets: vault,
    nativeAccount: {
      origin,
      secrets: vault,
      async fetch(url) {
        if (String(url) !== `${origin}/api/account/me`) throw new Error("fixture_network_refused");
        accountReads++;
        return Response.json({
          sessionId: credentials.sessionId,
          user: { id: "member" },
          organizations: [{ id: "personal", kind: "personal" }],
        });
      },
    },
    macCloudRunner: {
      start(options) {
        runner = options;
        starts++;
        return {
          async close() {
            closes++;
          },
        };
      },
    },
  });
  try {
    const client = accountBrokerClient({
      origin,
      socketPath: path.join(root, "account-ipc", "broker.sock"),
    });
    await client.save(credentials);
    expect(starts).toBe(0);
    expect(accountReads).toBe(0);

    await writeFile(
      path.join(root, "desktop", "mac-runner.json"),
      JSON.stringify({
        version: 1,
        sessionId: credentials.sessionId,
        orgId: "personal",
        runTasksOnMac: false,
        macExecution: "ask",
        folders: {},
      }),
      { mode: 0o600 },
    );
    await expect.poll(() => starts, { timeout: 8000 }).toBe(1);
    expect(runner?.capabilities).toEqual({ canRunTasks: false, canMacExec: true });
    expect(runner?.account.orgId).toBe("personal");
    expect(runner?.memberId).toBe("member");
    expect(runner?.macExecution?.mode()).toBe("ask");
    expect(accountReads).toBe(1);

    await client.clear();
    await expect.poll(() => closes).toBe(1);
    expect(runner?.macExecution?.mode()).toBe("off");
    expect(starts).toBe(1);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
