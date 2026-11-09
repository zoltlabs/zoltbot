import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { Redactor } from "./logging.js";
import { PrivateContexts, type PrivateVault } from "./private-context.js";

async function fixture(values: Record<string, unknown> = {}) {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/private-context-")),
    store = await openStore(path.join(root, "store.db"));
  for (const [id, value] of Object.entries(values))
    store.dispatch(`seed:${id}`, (state) =>
      handle(
        state,
        { type: "create", kind: "settings", value: { key: `runtime.privateRef.${id}`, value } },
        {
          commandId: `seed:${id}`,
          at: new Date().toISOString(),
          actor: { kind: "system", id: "runtime" },
        },
      ),
    );
  return {
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const valid = { version: 1, hideFrames: true, values: ["synthetic-private-context-value"] };
it("does not let a cached trusted legacy coverage claim hide an uncovered private marker", async () => {
  const test = await fixture();
  test.store.dispatch("legacy", (state) =>
    handle(
      state,
      { type: "create", kind: "settings", value: { key: "runtime.private.legacy", value: true } },
      {
        commandId: "legacy",
        at: new Date().toISOString(),
        actor: { kind: "system", id: "runtime" },
      },
    ),
  );
  const contexts = new PrivateContexts({
    store: test.store,
    publish() {},
    vault: {
      async put() {
        throw new Error("unexpected_put");
      },
      async read() {
        throw new Error("unexpected_read");
      },
    },
  });
  try {
    expect((await contexts.known(new Set(["legacy"]))).values.size).toBe(0);
    await expect(contexts.known()).rejects.toThrow("runtime_private_context_required");
  } finally {
    test.close();
  }
});

it("invalidates an in flight protected lookup when reference metadata changes", async () => {
  const test = await fixture({ session: "first" });
  let reads = 0;
  const contexts = new PrivateContexts({
    store: test.store,
    publish() {},
    vault: {
      async put() {
        throw new Error("unexpected_put");
      },
      async read(reference) {
        reads++;
        if (reference === "first")
          test.store.dispatch("replace-ref", (state) =>
            handle(
              state,
              {
                type: "update",
                kind: "settings",
                id: "runtime.privateRef.session",
                changes: { value: "second" },
              },
              {
                commandId: "replace-ref",
                at: new Date().toISOString(),
                actor: { kind: "system", id: "runtime" },
              },
            ),
          );
        return {
          ...valid,
          values: reference === "first" ? ["private-first"] : ["private-first", "private-second"],
        };
      },
    },
  });
  try {
    await expect(contexts.known()).rejects.toThrow("private_context_changed");
    expect([...(await contexts.known()).values]).toEqual(["private-first", "private-second"]);
    await contexts.known();
    expect(reads).toBe(2);
  } finally {
    test.close();
  }
});
it("does not fall back to an older context when the newest stored reference is malformed", async () => {
  const test = await fixture({ newer: { invalid: true }, older: "older" }),
    reads: string[] = [];
  try {
    const contexts = new PrivateContexts({
      store: test.store,
      publish() {},
      vault: {
        async put() {
          return { reference: "unused" };
        },
        async read(reference) {
          reads.push(reference);
          return valid;
        },
      },
    });
    await expect(contexts.restore(["newer", "older"], new Redactor())).rejects.toThrow(
      "runtime_private_context_required",
    );
    expect(reads).toEqual([]);
  } finally {
    test.close();
  }
});

it.each([
  { ...valid, version: 2 },
  { ...valid, hideFrames: false },
  { ...valid, values: ["valid", 2] },
  { ...valid, unexpected: "private" },
])("rejects an incompatible protected context before changing redaction", async (value) => {
  const test = await fixture({ session: "reference" }),
    redactor = new Redactor();
  try {
    const contexts = new PrivateContexts({
      store: test.store,
      publish() {},
      vault: {
        async put() {
          return { reference: "unused" };
        },
        async read() {
          return value;
        },
      },
    });
    await expect(contexts.restore(["session"], redactor)).rejects.toThrow(
      "runtime_private_context_required",
    );
    expect(redactor.hidesFrames).toBe(false);
    expect(redactor.text("synthetic-private-context-value")).toBe(
      "synthetic-private-context-value",
    );
  } finally {
    test.close();
  }
});

it("serializes additions, links only acknowledged opaque references, and restores the latest full set after rebuild", async () => {
  const test = await fixture(),
    values = new Set(["private-first"]),
    snapshots: unknown[] = [];
  let release: () => void = () => {},
    entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const vault: PrivateVault = {
    async put(value) {
      snapshots.push(value);
      if (snapshots.length === 1) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { reference: `reference-${snapshots.length}` };
    },
    async read(reference) {
      return snapshots[Number(reference.split("-")[1]) - 1];
    },
  };
  const contexts = new PrivateContexts({ store: test.store, vault, publish() {} });
  try {
    const first = contexts.persist("session", values);
    await started;
    expect(test.store.snapshot().settings ?? []).toHaveLength(0);
    values.add("private-second");
    const second = contexts.persist("session", values);
    release();
    await Promise.all([first, second]);
    await contexts.settle();
    expect(snapshots).toEqual([
      { version: 1, hideFrames: true, values: ["private-first"] },
      { version: 1, hideFrames: true, values: ["private-first", "private-second"] },
    ]);
    expect(JSON.stringify(test.store.snapshot())).not.toContain("private-first");
    expect(
      test.store.snapshot().settings?.find((row) => row.key === "runtime.privateRef.session")
        ?.value,
    ).toBe("reference-2");
    expect(
      test.store.snapshot().settings?.find((row) => row.key === "runtime.private.session")?.value,
    ).toBe(true);
    test.store.rebuild();
    const redactor = new Redactor();
    expect(await contexts.restore(["session"], redactor)).toEqual([
      "private-first",
      "private-second",
    ]);
    expect(redactor.text("private-first private-second")).toBe("[redacted] [redacted]");
    expect(redactor.hidesFrames).toBe(true);
  } finally {
    release();
    await contexts.settle();
    test.close();
  }
});
