import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseCredentials } from "../../packages/cloud-contracts/src/index.js";
import { startAccountBroker } from "../../packages/daemon/src/account-session/broker.js";
import { accountBrokerClient } from "../../packages/daemon/src/account-session/broker-client.js";
import { brokerRunnerRequest } from "../../packages/daemon/src/account-session/runner.js";
import { startDaemon } from "../../packages/daemon/src/api.js";
import { runnerAccount } from "../../packages/daemon/src/cloud-runner/account.js";
import { startMacRunner } from "../../packages/daemon/src/cloud-runner/mac.js";

// The harness starts this headless native host through a private IPC pipe.
// Account credentials and the stand-in keychain never become files or IPC replies.
let close: (() => Promise<void>) | undefined;
let started = false;
process.on("message", async (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const input = message as Record<string, unknown>;
  if (input.operation === "stop") {
    try {
      await close?.();
    } finally {
      process.disconnect?.();
    }
    return;
  }
  if (input.operation !== "start" || started) return;
  started = true;
  const values = new Map<string, unknown>();
  try {
    const directory = String(input.directory),
      origin = String(input.origin),
      orgId = String(input.orgId),
      memberId = String(input.memberId),
      deviceId = String(input.deviceId);
    const base = new URL(origin);
    if (!path.isAbsolute(directory) || base.hostname !== "127.0.0.1" || base.protocol !== "https:")
      throw new Error();
    const broker = await startAccountBroker({
      origin,
      directory: path.join(directory, "account"),
      referenceFile: path.join(directory, "reference"),
      secrets: {
        async put(value) {
          const reference = randomUUID();
          values.set(reference, structuredClone(value));
          return { reference };
        },
        async read(reference) {
          return structuredClone(values.get(reference));
        },
        async replace(reference, value) {
          if (!values.has(reference)) throw new Error();
          values.set(reference, structuredClone(value));
        },
        async remove(reference) {
          values.delete(reference);
        },
      },
    });
    close = async () => {
      await broker.close();
      values.clear();
    };
    const client = accountBrokerClient({ origin, socketPath: broker.location() });
    await client.save(parseCredentials(input.credentials));
    const account = { origin, orgId, deviceId, nativeRequest: brokerRunnerRequest(client) };
    const capabilities = { canRunTasks: false, canMacExec: true };
    await runnerAccount(account).setGrant(capabilities, new AbortController().signal);
    let runner: ReturnType<typeof startMacRunner> | undefined;
    const daemon = await startDaemon({
      dataDir: path.join(directory, "local"),
      cloudRunner(host) {
        runner = startMacRunner({
          directory: path.join(directory, "runner"),
          memberId,
          account,
          capabilities,
          versions: { daemon: "headless-fixture" },
          clis: [],
          guard() {},
          vault: async () => {
            throw new Error("fixture_native_task_refused");
          },
          tools: async () => {
            throw new Error("fixture_native_task_refused");
          },
          macExecution: {
            mac: "Harness Mac",
            osVersion: "fixture",
            mode: () => "ask",
            environment: { HOME: directory, ZDOTDIR: directory, PATH: "/usr/bin:/bin" },
            async task(taskId, _turnId) {
              return { active: taskId === input.taskId, folder: directory };
            },
          },
          status(code) {
            host.status(code);
            if (/^[a-z_]{1,100}$/.test(code)) process.send?.({ type: "status", code });
          },
        });
        return runner;
      },
    });
    if (!runner) {
      await daemon.close();
      throw new Error();
    }
    close = async () => {
      try {
        await daemon.close();
      } finally {
        await broker.close();
        values.clear();
      }
    };
    process.send?.({ type: "ready" });
  } catch {
    await close?.().catch(() => {});
    values.clear();
    process.send?.({ type: "failed" });
    process.disconnect?.();
  }
});
process.once("disconnect", () => {
  void close?.().finally(() => process.exit());
});
