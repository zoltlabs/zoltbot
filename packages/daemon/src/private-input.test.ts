import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { InteractionEngine } from "./interaction-engine.js";
import { PrivateInputGuard } from "./private-input.js";

it("checks protected values before late forwarding without a native runtime", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/private-input-"));
  const store = await openStore(path.join(root, "store.db"));
  const secret = "synthetic-private-disconnected-value";
  const actor = { kind: "human" as const, id: "owner" };
  try {
    for (const [kind, value] of [
      [
        "agentDefinition",
        {
          id: "fake",
          displayName: "Fake",
          adapter: "acp",
          binaryNames: [],
          versionCommand: [],
          launch: { command: "fake", args: [], env: {} },
          testedVersions: "1.0.0",
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
          name: "Builder",
          avatar: "B",
          definitionId: "fake",
          kind: "profile",
          permissionProfile: "read_only",
          instructions: "",
          hidden: false,
          archived: false,
        },
      ],
    ] as const)
      store.dispatch(`seed:${kind}`, (state) =>
        handle(
          state,
          { type: "create", kind, value },
          { commandId: `seed:${kind}`, actor, at: new Date().toISOString() },
        ),
      );
    store.dispatch("seed-thread", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "thread",
          value: {
            id: "thread",
            agentId: "profile",
            kind: "main",
            title: "Test",
            titleSource: "human",
            pinned: false,
            archived: false,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
          },
        },
        { commandId: "seed-thread", actor, at: new Date().toISOString() },
      ),
    );
    store.dispatch("seed-reference", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "settings",
          value: { key: "runtime.privateRef.old-session", value: "protected-reference" },
        },
        { commandId: "seed-reference", actor, at: new Date().toISOString() },
      ),
    );
    const guard = new PrivateInputGuard({
      store,
      publish() {},
      secrets: {
        async put() {
          throw new Error("unexpected_put");
        },
        async read(reference) {
          expect(reference).toBe("protected-reference");
          return { version: 1, hideFrames: true, values: [secret] };
        },
      },
    });
    const engine = new InteractionEngine({
      store,
      publish() {},
      prepareInput: (input) => guard.prepareInput(input),
    });
    engine.request(
      {
        id: "late",
        agentId: "profile",
        threadId: "thread",
        type: "question",
        items: [{ id: "q", prompt: "Note", allowOther: true }],
        urgency: "blocking",
        chain: [],
      },
      "request",
    );
    engine.clearRequests(["late"], "provider_cleared", "expire");
    const before = store.lastSeq();
    await expect(
      engine.forwardLate(
        { id: "late", version: 2, text: `Copy ${secret}`, confirmed: true },
        "private-copy",
        actor,
      ),
    ).rejects.toThrow("private_value_requires_secure_field");
    expect(store.lastSeq()).toBe(before);
    expect(store.receipt("private-copy")).toBeUndefined();
    await engine.forwardLate(
      { id: "late", version: 2, text: "Public note", confirmed: true },
      "public-note",
      actor,
    );
    expect(store.snapshot().item?.some((row) => JSON.stringify(row).includes("Public note"))).toBe(
      true,
    );
    expect(JSON.stringify(store.snapshot())).not.toContain(secret);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
