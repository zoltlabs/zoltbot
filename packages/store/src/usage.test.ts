import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { handle, recordUsage } from "@zoltbot/core";
import type { EntityKind } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { openStore } from "./index.js";

const at = "2026-10-28T12:00:00Z";
const context = { commandId: "usage", at, actor: { kind: "system" as const, id: "runtime" } };
it("rolls back every usage dispatch stage and rebuilds the same per turn totals", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/usage-store-"));
  const store = await openStore(path.join(root, "store.db"));
  try {
    const rows: [EntityKind, Record<string, unknown>][] = [
      [
        "agentDefinition",
        {
          id: "fake",
          displayName: "Fake",
          adapter: "reference",
          binaryNames: [],
          versionCommand: [],
          launch: { command: "fake", args: [], env: {} },
          testedVersions: "fixture",
          defaults: { permissionProfile: "read_only" },
          staticCapabilities: {},
          nativeSessionRoots: [],
          experimental: false,
        },
      ],
      [
        "agent",
        {
          id: "profile",
          name: "Fixture",
          avatar: "F",
          definitionId: "fake",
          kind: "profile",
          permissionProfile: "read_only",
          instructions: "",
          hidden: false,
          archived: false,
        },
      ],
      [
        "thread",
        {
          id: "thread",
          agentId: "profile",
          kind: "main",
          title: "Fixture",
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: at,
          lastActivityAt: at,
        },
      ],
      [
        "session",
        {
          id: "session",
          threadId: "thread",
          provider: "reference",
          nativeId: "native",
          cwd: root,
          state: "starting",
          capabilities: {},
          startedAt: at,
        },
      ],
      [
        "turn",
        {
          id: "turn",
          threadId: "thread",
          sessionId: "session",
          status: "running",
          origin: "human",
          startedAt: at,
        },
      ],
    ];
    for (const [kind, value] of rows)
      store.dispatch(`seed:${kind}`, (state) =>
        handle(state, { type: "create", kind, value }, { ...context, commandId: `seed:${kind}` }),
      );
    const input = {
      sessionId: "session",
      turnId: "turn",
      injectedTokens: 40,
      sample: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, costUsd: 0.25 },
    };
    const before = store.snapshot(),
      seq = store.lastSeq();
    for (const killPoint of [
      "before_events",
      "after_events",
      "after_projections",
      "after_receipt",
    ] as const) {
      expect(() =>
        store.dispatch("usage", (state) => recordUsage(state, input, context), { killPoint }),
      ).toThrow("kill point");
      expect(store.snapshot()).toEqual(before);
      expect(store.lastSeq()).toBe(seq);
      expect(store.receipt("usage")).toBeUndefined();
    }
    const receipt = store.dispatch("usage", (state) => recordUsage(state, input, context));
    expect(
      store.dispatch("usage", (state) =>
        recordUsage(state, { ...input, sample: { inputTokens: 200 } }, context),
      ),
    ).toEqual(receipt);
    expect(store.snapshot().usage).toHaveLength(1);
    expect(store.snapshot().usage?.[0]).toMatchObject({
      inputTokens: 100,
      costUsd: 0.25,
      injectedTokens: 40,
    });
    const snapshot = store.snapshot();
    store.rebuild();
    expect(store.snapshot()).toEqual(snapshot);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
