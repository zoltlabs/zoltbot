import path from "node:path";
import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { DaemonClient } from "../../ui/src/connection.js";
import { startDaemon } from "./api.js";

const reference = "keychain:zoltbot:11111111-1111-4111-8111-111111111111";
it("restores protected values before masking settings after restart and protects internal private markers", async () => {
  const f = await runtimeFixture();
  const secret = "synthetic-settings-private-after-restart";
  let reads = 0;
  let unavailable = false;
  const secrets = {
    async read(value: string) {
      expect(value).toBe(reference);
      reads++;
      if (unavailable) throw new Error("synthetic-private-storage-error");
      return secret;
    },
    async put() {
      throw new Error("must not write");
    },
  };
  const dataDir = path.join(f.root, "daemon");
  let daemon = await startDaemon({ dataDir, secrets });
  let client: DaemonClient | undefined;
  try {
    const definition = f.store.snapshot().agentDefinition?.[0];
    if (!definition) throw new Error("fixture definition missing");
    daemon.store.dispatch("credential-definition", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "agentDefinition",
          value: {
            ...definition,
            launch: { ...(definition.launch as object), env: { API_KEY: reference } },
          },
        },
        {
          commandId: "credential-definition",
          at: "2026-10-29T00:00:00Z",
          actor: { kind: "system", id: "fixture" },
        },
      ),
    );
    await daemon.close();
    daemon = await startDaemon({ dataDir, secrets });
    client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
    await client.start();
    expect(reads).toBe(0);
    await client.call("settings.set", { key: "note", value: `value ${secret}` }, "masked-setting");
    expect(reads).toBe(1);
    expect(JSON.stringify(daemon.store.snapshot())).not.toContain(secret);
    expect(daemon.store.snapshot(["settings"]).settings).toContainEqual({
      key: "note",
      value: "value [redacted]",
    });
    const before = daemon.store.lastSeq();
    for (const key of [
      "runtime.private.forged",
      "runtime.privateRef.forged",
      "view.origin.forged",
      "view.proposal.forged",
    ]) {
      await expect(
        client.call("settings.set", { key, value: true }, `reserved:${key}`),
      ).rejects.toThrow("setting_reserved");
      expect(daemon.store.receipt(`reserved:${key}`)).toBeUndefined();
    }
    expect(daemon.store.lastSeq()).toBe(before);
    client.stop();
    await daemon.close();
    unavailable = true;
    daemon = await startDaemon({ dataDir, secrets });
    client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
    await client.start();
    await expect(
      client.call("settings.set", { key: "note", value: `value ${secret}` }, "masked-setting"),
    ).resolves.toEqual({ ok: true });
    expect(reads).toBe(1);
    expect(daemon.store.lastSeq()).toBe(before);
    await expect(
      client.call("settings.set", { key: "another", value: "public" }, "unavailable-setting"),
    ).rejects.toThrow("runtime_credentials_unavailable");
    expect(daemon.store.receipt("unavailable-setting")).toBeUndefined();
  } finally {
    client?.stop();
    await daemon.close();
    f.close();
  }
});

it("refuses a settings write if its protected reference changes during vault lookup", async () => {
  const f = await runtimeFixture();
  let release: ((value: unknown) => void) | undefined;
  let entered = () => {};
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const daemon = await startDaemon({
    dataDir: path.join(f.root, "daemon"),
    secrets: {
      read: () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
      async put() {
        throw new Error("must not write");
      },
    },
  });
  const definition = f.store.snapshot().agentDefinition?.[0];
  if (!definition) throw new Error("fixture definition missing");
  const client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
  try {
    daemon.store.dispatch("seed", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "agentDefinition",
          value: {
            ...definition,
            launch: { ...(definition.launch as object), env: { API_KEY: reference } },
          },
        },
        { commandId: "seed", at: "2026-10-29T00:00:00Z", actor: { kind: "system", id: "fixture" } },
      ),
    );
    await client.start();
    const sending = client.call("settings.set", { key: "note", value: "public" }, "stale-setting");
    const rejected = expect(sending).rejects.toThrow("private_context_changed");
    await reading;
    daemon.store.dispatch("change", (state) =>
      handle(
        state,
        {
          type: "update",
          kind: "agentDefinition",
          id: String(definition.id),
          changes: {
            launch: {
              ...(definition.launch as object),
              env: { API_KEY: "keychain:zoltbot:22222222-2222-4222-8222-222222222222" },
            },
          },
        },
        {
          commandId: "change",
          at: "2026-10-29T00:00:00Z",
          actor: { kind: "system", id: "fixture" },
        },
      ),
    );
    release?.("synthetic-private-stale-setting");
    await rejected;
    expect(daemon.store.receipt("stale-setting")).toBeUndefined();
    expect(daemon.store.snapshot(["settings"]).settings ?? []).toHaveLength(0);
  } finally {
    release?.("synthetic-private-stale-setting");
    client.stop();
    await daemon.close();
    f.close();
  }
});
