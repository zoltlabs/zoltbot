import { handle } from "@zoltbot/core";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { Redactor } from "./logging.js";
import { PrivateInputGuard } from "./private-input.js";

const first = "keychain:zoltbot:11111111-1111-4111-8111-111111111111",
  second = "keychain:zoltbot:22222222-2222-4222-8222-222222222222";
const actor = { kind: "human" as const, id: "owner" };
async function fixture() {
  const f = await runtimeFixture();
  let version = 0;
  const definitionId = String(f.store.snapshot().agentDefinition?.[0]?.id);
  return {
    ...f,
    set: (reference: string) =>
      f.store.dispatch(`credential:${++version}`, (state) =>
        handle(
          state,
          {
            type: "update",
            kind: "agentDefinition",
            id: definitionId,
            changes: {
              launch: {
                ...(state.agentDefinition?.[0]?.launch as object),
                env: { API_KEY: reference },
              },
            },
          },
          { commandId: `credential:${version}`, at: "2026-10-29T00:00:00Z", actor },
        ),
      ),
  };
}

it("protects registered environment credentials before native open and after guard recreation", async () => {
  const f = await fixture();
  const secret = "synthetic-private-environment-value";
  const vault = {
    async read() {
      return secret;
    },
    async put() {
      throw new Error("must not write");
    },
  };
  try {
    f.set(first);
    for (let attempt = 0; attempt < 2; attempt++) {
      const guard = new PrivateInputGuard({ store: f.store, secrets: vault, publish() {} });
      const redactor = new Redactor();
      guard.track(redactor);
      await expect(guard.prepareData(secret)).rejects.toThrow(
        "private_value_requires_secure_field",
      );
      expect(redactor.text(secret)).toBe("[redacted]");
      expect(redactor.hidesFrames).toBe(true);
      const check = await guard.prepareData("ordinary public input");
      check(f.store.snapshot());
    }
    expect(f.store.snapshot().session).toHaveLength(1);
    expect(JSON.stringify(f.store.snapshot())).not.toContain(secret);
  } finally {
    f.close();
  }
});
it("fences changed credential references during protected lookup and refuses unavailable storage", async () => {
  const f = await fixture();
  let release: ((value: unknown) => void) | undefined;
  try {
    f.set(first);
    const guard = new PrivateInputGuard({
      store: f.store,
      secrets: {
        read: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        async put() {
          throw new Error("must not write");
        },
      },
      publish() {},
    });
    const checking = guard.prepareData("ordinary public input");
    f.set(second);
    release?.("synthetic-private-old-value");
    await expect(checking).rejects.toThrow("private_context_changed");
    const unavailable = new PrivateInputGuard({ store: f.store, publish() {} });
    await expect(unavailable.prepareData("ordinary public input")).rejects.toThrow(
      "runtime_credentials_unavailable",
    );
  } finally {
    f.close();
  }
});
