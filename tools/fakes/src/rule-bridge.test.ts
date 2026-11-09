import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { type Daemon, startDaemon } from "@zoltbot/daemon";
import type { EntityKind } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { ruleApi } from "../../../packages/daemon/src/rule-api.js";
import { claudeFactory } from "./claude-conformance-factory.js";

it("revokes an automatic approval for the next request in the same native fake session", async () => {
  const fixture = await claudeFactory("approve");
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/rule-bridge-"));
  let daemon: Daemon | undefined;
  const at = "2026-10-28T12:00:00.000Z";
  try {
    daemon = await startDaemon({
      dataDir: root,
      interactionHost: {
        registerSecret() {},
        requiresSecretReply: () => true,
        respond: (request, answer) => fixture.session.respond(request.id, answer),
      },
    });
    const rows: [EntityKind, Record<string, unknown>][] = [
      [
        "agentDefinition",
        {
          id: "fake",
          displayName: "Fake",
          adapter: "claude",
          binaryNames: [],
          versionCommand: [],
          launch: { command: "fake", args: [], env: {} },
          testedVersions: "fixture",
          defaults: { permissionProfile: "workspace_write" },
          staticCapabilities: {},
          nativeSessionRoots: [],
          experimental: false,
        },
      ],
      [
        "agent",
        {
          id: "test-profile",
          name: "Fixture",
          avatar: "F",
          definitionId: "fake",
          kind: "profile",
          permissionProfile: "workspace_write",
          instructions: "",
          hidden: false,
          archived: false,
        },
      ],
      [
        "thread",
        {
          id: "test-thread",
          agentId: "test-profile",
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
          id: "runtime",
          threadId: "test-thread",
          provider: "claude",
          nativeId: fixture.session.nativeId,
          cwd: fixture.cwd,
          state: "starting",
          capabilities: fixture.session.capabilities,
          startedAt: at,
        },
      ],
    ];
    for (const [kind, value] of rows)
      daemon.dispatch({ type: "create", kind, value }, `seed:${kind}`);
    const api = ruleApi({ store: daemon.store, publish() {} });
    const rule = api(
      "rule.create",
      {
        rule: {
          scope: "global",
          matcher: { tool: "Bash", command: { prefix: ["cat"] } },
          decision: "allow",
        },
        confirmed: true,
      },
      "allow-cat",
    ) as { id: string };
    for (let round = 0; round < 2; round++) {
      const start = fixture.trace.length;
      await fixture.session.send([{ type: "text", text: "approval" }], "queue");
      await expect
        .poll(() => fixture.trace.slice(start).some((event) => event.t === "interaction.requested"))
        .toBe(true);
      const event = fixture.trace.slice(start).find((event) => event.t === "interaction.requested");
      if (!event || event.t !== "interaction.requested" || !event.interaction.turnId)
        throw new Error("missing_approval");
      daemon.dispatch(
        {
          type: "create",
          kind: "turn",
          value: {
            id: event.interaction.turnId,
            threadId: "test-thread",
            sessionId: "runtime",
            status: "running",
            origin: "human",
            startedAt: at,
          },
        },
        `turn:${round}`,
      );
      const request = daemon.interactions?.request(event.interaction, `approval:${round}`);
      if (!request || !daemon.interactions) throw new Error("engine_unavailable");
      if (round === 1) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        expect(fixture.trace.slice(start).some((event) => event.t === "turn.done")).toBe(false);
        expect(
          daemon.store.snapshot().interaction?.find((row) => row.id === request.id)?.state,
        ).toBe("pending");
        await daemon.interactions.answer(
          request.id,
          1,
          { action: "accept", choice: "allow_once", by: { kind: "human", id: "owner" }, at },
          "human-answer",
          { kind: "human", id: "owner" },
        );
      }
      await expect
        .poll(() =>
          fixture.trace
            .slice(start)
            .some((event) => event.t === "turn.done" && event.status === "completed"),
        )
        .toBe(true);
      if (round === 0) api("rule.revoke", { id: rule.id }, "revoke");
    }
    const answers = daemon.store
      .snapshot()
      .audit?.filter((row) => row.action === "interaction.answer");
    expect(answers).toHaveLength(2);
    expect(
      answers?.filter((row) => (row.detail as { ruleId?: string }).ruleId === rule.id),
    ).toHaveLength(1);
  } finally {
    await daemon?.close();
    await fixture.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
