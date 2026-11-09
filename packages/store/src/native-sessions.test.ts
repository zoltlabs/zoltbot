import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { adoptNativeSession, handle, reconcileNativeSessions } from "@zoltbot/core";
import { expect, it } from "vitest";
import { openStore } from "./index.js";

it("atomically reconciles session metadata and replays a committed scan exactly once", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/native-index-"));
  const store = await openStore(path.join(root, "store.db"));
  try {
    const context = {
      commandId: "scan-one",
      at: "2026-10-27T12:00:00.000Z",
      actor: { kind: "system" as const, id: "session-index" },
    };
    const sessions = [
      {
        provider: "codex",
        nativeId: "one",
        adopted: false,
        missing: false,
        lastSeenAt: context.at,
      },
    ];
    const produce = (state: ReturnType<typeof store.snapshot>) =>
      reconcileNativeSessions(state, "codex", sessions, context);
    for (const killPoint of [
      "before_events",
      "after_events",
      "after_projections",
      "after_receipt",
    ] as const) {
      expect(() => store.dispatch(context.commandId, produce, { killPoint })).toThrow("kill point");
      expect(store.snapshot()).toEqual({});
      expect(store.lastSeq()).toBe(0);
    }
    const receipt = store.dispatch(context.commandId, produce);
    expect(store.snapshot().nativeSession).toEqual(sessions);
    expect(
      store.dispatch(context.commandId, () => {
        throw new Error("must not rerun");
      }),
    ).toEqual(receipt);
    expect(store.lastSeq()).toBe(1);
    store.dispatch("scan-two", (state) =>
      reconcileNativeSessions(state, "codex", [], { ...context, commandId: "scan-two" }),
    );
    expect(store.snapshot().nativeSession).toEqual([{ ...sessions[0], missing: true }]);
    const snapshot = store.snapshot();
    store.rebuild();
    expect(store.snapshot()).toEqual(snapshot);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("commits adoption links, threads, and audit together with rollback and rebuild", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/native-adopt-store-"));
  const store = await openStore(path.join(root, "store.db"));
  const context = {
    commandId: "adoption",
    at: "2026-10-27T12:00:00.000Z",
    actor: { kind: "human" as const, id: "owner" },
  };
  try {
    const definition = {
      id: "codex-local",
      displayName: "Codex",
      adapter: "codex",
      binaryNames: ["codex"],
      versionCommand: ["--version"],
      launch: { command: "codex", args: [], env: {} },
      testedVersions: "1.0.0",
      defaults: { permissionProfile: "read_only" },
      staticCapabilities: {},
      nativeSessionRoots: [],
      experimental: false,
    };
    const profile = {
      id: "profile",
      name: "Builder",
      avatar: "B",
      definitionId: definition.id,
      kind: "profile",
      permissionProfile: "read_only",
      instructions: "",
      hidden: false,
      archived: false,
    };
    for (const [kind, value] of [
      ["agentDefinition", definition],
      ["agent", profile],
    ] as const) {
      const commandId = `seed:${kind}`;
      store.dispatch(commandId, (state) =>
        handle(state, { type: "create", kind, value }, { ...context, commandId }),
      );
    }
    const session = {
      provider: "codex",
      nativeId: "one",
      adopted: false,
      missing: false,
      lastSeenAt: context.at,
    };
    const produce = (state: ReturnType<typeof store.snapshot>) =>
      adoptNativeSession(
        state,
        { session, profileId: profile.id, threadId: "thread", confirmed: true },
        context,
      );
    const before = store.snapshot(),
      seq = store.lastSeq();
    expect(() =>
      store.dispatch(context.commandId, produce, { killPoint: "after_projections" }),
    ).toThrow("kill point");
    expect(store.snapshot()).toEqual(before);
    expect(store.lastSeq()).toBe(seq);
    const receipt = store.dispatch(context.commandId, produce);
    expect(store.snapshot().thread).toHaveLength(1);
    expect(store.snapshot().nativeSession?.[0]).toMatchObject({
      adopted: true,
      threadId: "thread",
    });
    expect(store.snapshot().audit).toHaveLength(1);
    expect(
      store.dispatch(context.commandId, () => {
        throw new Error("must not rerun");
      }),
    ).toEqual(receipt);
    const committed = store.snapshot();
    store.rebuild();
    expect(store.snapshot()).toEqual(committed);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
