import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { handle, queueHumanInput } from "@zoltbot/core";
import type { EntityKind } from "@zoltbot/protocol";
import { openStore } from "@zoltbot/store";
export const at = "2026-10-28T12:00:00Z";
export async function runtimeFixture(databaseName = "store.db") {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/runtime-"));
  const store = await openStore(path.join(root, databaseName));
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
        cwd: root,
        state: "starting",
        capabilities: {},
        startedAt: at,
      },
    ],
  ];
  for (const [kind, value] of rows)
    store.dispatch(`seed:${kind}`, (state) =>
      handle(
        state,
        { type: "create", kind, value },
        { commandId: `seed:${kind}`, at, actor: { kind: "system", id: "runtime" } },
      ),
    );
  const queue = (id: string, text: string, mode: "queue" | "steer" = "queue") =>
    store.dispatch(id, (state) =>
      queueHumanInput(state, { threadId: "thread", input: [{ type: "text", text }], mode }, id, {
        commandId: id,
        at,
        actor: { kind: "human", id: "owner" },
      }),
    );
  return {
    root,
    store,
    queue,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
