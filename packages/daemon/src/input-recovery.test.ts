import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { claimQueuedInput, queueHumanInput } from "@zoltbot/core";
import type { EntityKind } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { type Daemon, startDaemon } from "./api.js";

const at = "2026-10-28T12:00:00Z";
const human = { commandId: "queue", at, actor: { kind: "human" as const, id: "owner" } };
it("holds an in flight input as uncertain after restart and leaves unsent inputs queued", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/input-recovery-"));
  let daemon: Daemon | undefined;
  try {
    daemon = await startDaemon({ dataDir: root });
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
    ];
    for (const [kind, value] of rows)
      daemon.dispatch({ type: "create", kind, value }, `seed:${kind}`);
    daemon.dispatch({ type: "transition", kind: "session", id: "session", to: "ready" }, "ready");
    for (const id of ["sending", "unsent"])
      daemon.store.dispatch(`queue:${id}`, (state) =>
        queueHumanInput(
          state,
          {
            threadId: "thread",
            mode: "queue",
            input: [{ type: "text", text: `Exact human text ${id}` }],
          },
          id,
          { ...human, commandId: `queue:${id}` },
        ),
      );
    const beforeClaim = daemon.store.snapshot(),
      beforeSeq = daemon.store.lastSeq();
    for (const killPoint of [
      "before_events",
      "after_events",
      "after_projections",
      "after_receipt",
    ] as const) {
      expect(() =>
        daemon?.store.dispatch(
          "claim",
          (state) =>
            claimQueuedInput(state, "sending", "session", "attempt", {
              ...human,
              commandId: "claim",
              actor: { kind: "system", id: "runtime" },
            }),
          { killPoint },
        ),
      ).toThrow("kill point");
      expect(daemon.store.snapshot()).toEqual(beforeClaim);
      expect(daemon.store.lastSeq()).toBe(beforeSeq);
    }
    daemon.store.dispatch("claim", (state) =>
      claimQueuedInput(state, "sending", "session", "attempt", {
        ...human,
        commandId: "claim",
        actor: { kind: "system", id: "runtime" },
      }),
    );
    daemon.dispatch(
      {
        type: "create",
        kind: "item",
        value: {
          id: "unfinished-tool",
          threadId: "thread",
          seq: 3,
          kind: "tool",
          body: { status: "running", input: { command: "fixture" } },
          createdAt: at,
          updatedAt: at,
        },
      },
      "seed:unfinished-tool",
    );
    await daemon.close();
    daemon = await startDaemon({ dataDir: root });
    const snapshot = daemon.store.snapshot();
    expect(snapshot.item?.find((row) => row.id === "unfinished-tool")?.body).toMatchObject({
      status: "unconfirmed",
      partial: true,
    });
    expect(snapshot.session?.[0]?.endReason).toBe("daemon_restart");
    expect(snapshot.item?.find((row) => row.id === "sending")?.body).toMatchObject({
      queueState: "uncertain",
      errorCode: "delivery_uncertain",
      input: [{ type: "text", text: "Exact human text sending" }],
    });
    expect(snapshot.item?.find((row) => row.id === "unsent")?.body).toMatchObject({
      queueState: "queued",
    });
    expect(snapshot.item?.filter((row) => row.kind === "note")).toHaveLength(1);
    expect(() =>
      claimQueuedInput(snapshot, "sending", "session", "retry", {
        ...human,
        actor: { kind: "system", id: "runtime" },
      }),
    ).toThrow("input_not_queued");
    daemon.store.rebuild();
    expect(daemon.store.snapshot()).toEqual(snapshot);
    await daemon.close();
    daemon = await startDaemon({ dataDir: root });
    expect(daemon.store.snapshot().item?.filter((row) => row.kind === "note")).toHaveLength(1);
  } finally {
    await daemon?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
