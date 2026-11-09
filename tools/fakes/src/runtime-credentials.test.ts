import { readFileSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { Logger } from "../../../packages/daemon/src/logging.js";
import { KeychainSecrets } from "../../../packages/daemon/src/secrets.js";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { ReferenceSession } from "./reference-adapter.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

async function fixture() {
  const f = await runtimeFixture();
  const values = new Map<string, string>();
  const vault = new KeychainSecrets(async (request) => {
    if (request.op === "put") {
      values.set(request.account, request.value ?? "");
      return { ok: true };
    }
    return { ok: true, value: values.get(request.account) };
  });
  const secret = "synthetic-native-environment-credential",
    saved = await vault.put(secret);
  f.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  const definitionId = String(f.store.snapshot().agentDefinition?.[0]?.id);
  f.store.dispatch("credential-definition", (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "agentDefinition",
        id: definitionId,
        changes: {
          launch: {
            ...(state.agentDefinition?.[0]?.launch as object),
            env: { ZOLTBOT_TEST_API_KEY: saved.reference },
          },
          auth: { apiKeyEnv: "ZOLTBOT_TEST_API_KEY" },
        },
      },
      { commandId: "credential-definition", at, actor: { kind: "human", id: "owner" } },
    ),
  );
  return { ...f, vault, secret, reference: saved.reference };
}
it("protects resolved credentials before a real native child receives them and persists only opaque context references", async () => {
  const f = await fixture();
  let opened = 0;
  const manager = new SessionManager({
    store: f.store,
    secrets: f.vault,
    publish() {},
    host: {
      async prepare(input, redactor) {
        expect(input.definition.launch.env.ZOLTBOT_TEST_API_KEY).toBe(f.secret);
        expect(redactor.hidesFrames).toBe(true);
        new Logger(path.join(f.root, "adapter.log"), redactor).write(
          "info",
          "Synthetic preparation",
          { detail: `Environment: ${f.secret}` },
        );
        return {
          cwd: f.root,
          estimate: (text) => text.length,
          async open(request) {
            opened++;
            expect(
              f.store
                .snapshot()
                .settings?.some((row) => row.key === `runtime.privateRef.${request.sessionId}`),
            ).toBe(true);
            return new ReferenceSession(
              {
                identity: { agentId: "profile", threadId: "thread" },
                mode: request.mode,
                ...(request.nativeId ? { nativeId: request.nativeId } : {}),
                cwd: f.root,
                env: input.definition.launch.env,
                permissionProfile: "read_only",
                hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
              },
              undefined,
              1500,
              redactor,
            ).open();
          },
        };
      },
    },
  });
  try {
    const worker = await manager.ensure("thread");
    f.queue("credential-message", "credential_echo");
    await worker.wake();
    await expect
      .poll(() => f.store.snapshot().turn?.some((row) => row.status === "completed"))
      .toBe(true);
    expect(opened).toBe(1);
    const state = f.store.snapshot();
    expect(
      state.item?.filter((row) => row.kind === "message").map((row) => row.body),
    ).toContainEqual(expect.objectContaining({ text: "Environment echo: [redacted]" }));
    expect(
      (state.agentDefinition?.[0]?.launch as { env: Record<string, string> }).env
        .ZOLTBOT_TEST_API_KEY,
    ).toBe(f.reference);
    expect(JSON.stringify(state)).not.toContain(f.secret);
    for (const name of ["store.db", "store.db-wal", "frames.jsonl", "adapter.log"])
      expect(readFileSync(path.join(f.root, name)).includes(Buffer.from(f.secret))).toBe(false);
    expect(readFileSync(path.join(f.root, "adapter.log"), "utf8")).toContain("[redacted]");
    await expect(manager.prepareInput([{ type: "text", text: f.secret }])).rejects.toThrow(
      "private_value_requires_secure_field",
    );
  } finally {
    await manager.close();
    f.close();
  }
});
it("does not open a native process when protected context persistence fails", async () => {
  const f = await fixture();
  let opened = 0;
  const manager = new SessionManager({
    store: f.store,
    secrets: {
      read: (ref) => f.vault.read(ref),
      async put() {
        throw new Error("synthetic-private-persistence-failure");
      },
    },
    publish() {},
    host: {
      async prepare() {
        return {
          cwd: f.root,
          estimate: (text) => text.length,
          async open() {
            opened++;
            throw new Error("native must not open");
          },
        };
      },
    },
  });
  try {
    await expect(manager.ensure("thread")).rejects.toThrow(/^runtime_open_failed$/);
    expect(opened).toBe(0);
    expect(f.store.snapshot().session?.filter((row) => row.state === "failed")).toHaveLength(1);
    expect(JSON.stringify(f.store.snapshot())).not.toContain(f.secret);
  } finally {
    await manager.close();
    f.close();
  }
});
