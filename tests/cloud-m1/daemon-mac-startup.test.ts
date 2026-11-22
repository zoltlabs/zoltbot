import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { expect, it } from "vitest";
import { accountBrokerClient } from "../../packages/daemon/src/account-session/broker-client.js";
import { brokerRunnerRequest } from "../../packages/daemon/src/account-session/runner.js";
import { startDaemon } from "../../packages/daemon/src/api.js";
import { runnerAccount } from "../../packages/daemon/src/cloud-runner/account.js";
import { macIdentity } from "../../packages/daemon/src/link-identity.js";
import { linkId, toB64 } from "../../packages/link/src/index.js";
import { cloudHarness } from "./harness.js";

it("connects the real daemon Mac runner with an explicit account grant and the daemon identity", async () => {
  const harness = await cloudHarness("claude");
  const dataDir = path.join(harness.root, "startup");
  const origin = harness.proxy.origin();
  const originalCa = getCACertificates("default");
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
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    setDefaultCACertificates([...originalCa, harness.tls.certificate()]);
    daemon = await startDaemon({
      dataDir,
      secrets: vault,
      nativeAccount: {
        origin,
        secrets: vault,
        fetch: (input, init) =>
          harness.fetch(new URL(String(input)), {
            ...(init?.method ? { method: init.method } : {}),
            headers: Object.fromEntries(new Headers(init?.headers)),
            ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
          }),
      },
      macCloudRunner: true,
    });
    const identity = await macIdentity({ store: daemon.store, vault, publish() {} })();
    const deviceId = linkId(identity.publicKey);
    const session = harness.account.nativeSession({
      userId: "member",
      orgId: "personal",
      deviceId,
      surface: "desktop",
    });
    const broker = accountBrokerClient({
      origin,
      socketPath: path.join(dataDir, "account-ipc", "broker.sock"),
    });
    await broker.save(session);
    await broker.cloudRequest(
      "/api/cloud/devices",
      "POST",
      JSON.stringify({ deviceId, publicKey: toB64(identity.publicKey) }),
    );
    await runnerAccount({
      origin,
      orgId: "personal",
      deviceId,
      nativeRequest: brokerRunnerRequest(broker),
    }).setGrant({ canRunTasks: false, canMacExec: true }, AbortSignal.timeout(8000));
    await writeFile(
      path.join(dataDir, "desktop", "mac-runner.json"),
      JSON.stringify({
        version: 1,
        sessionId: session.sessionId,
        orgId: "personal",
        runTasksOnMac: false,
        macExecution: "ask",
        folders: {},
      }),
      { mode: 0o600 },
    );
    await expect
      .poll(
        async () =>
          (await readFile(path.join(dataDir, "daemon.log"), "utf8").catch(() => "")).includes(
            "runner_connected",
          ),
        { timeout: 12_000 },
      )
      .toBe(true);
    expect(harness.cell.refusedNetwork()).toBe(0);
  } finally {
    try {
      await daemon?.close();
    } finally {
      setDefaultCACertificates(originalCa);
      await harness.close();
    }
  }
}, 35_000);
