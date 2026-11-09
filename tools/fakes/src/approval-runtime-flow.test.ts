import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { SessionManager } from "@zoltbot/daemon";
import { expect, it } from "vitest";
import { InteractionEngine } from "../../../packages/daemon/src/interaction-engine.js";
import { ReferenceSession } from "./reference-adapter.js";
import { runtimeFixture } from "./runtime-fixture.js";

it("answers a real native path request by rule while keeping its persisted display and frames redacted", async () => {
  const test = await runtimeFixture();
  mkdirSync(path.join(test.root, "src"));
  let engine: InteractionEngine;
  let native: ReferenceSession | undefined;
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    interactions: async () => engine,
    host: {
      async prepare(input, redactor) {
        redactor.register(test.root);
        return {
          cwd: test.root,
          estimate: (text) => text.length,
          async open(request) {
            native = new ReferenceSession(
              {
                mode: request.mode,
                identity: { agentId: input.profile.id, threadId: input.thread.id },
                cwd: test.root,
                permissionProfile: input.profile.permissionProfile,
                hostMcp: { url: "http://127.0.0.1:1", token: "synthetic" },
              },
              undefined,
              1000,
              redactor,
            );
            return native.open();
          },
        };
      },
    },
  });
  engine = new InteractionEngine({
    store: test.store,
    host: manager.interactionHost,
    publish() {},
  });
  const at = new Date().toISOString();
  const human = { kind: "human" as const, id: "owner" };
  try {
    for (const [commandId, command] of [
      ["close-seed", { type: "transition", kind: "session", id: "session", to: "closed" }],
      [
        "workspace-profile",
        {
          type: "update",
          kind: "agent",
          id: "profile",
          changes: { permissionProfile: "workspace_write" },
          confirmed: true,
        },
      ],
      [
        "path-rule",
        {
          type: "create",
          kind: "rule",
          confirmed: true,
          value: {
            id: "allow-src",
            scope: "global",
            matcher: { tool: "Write", kind: "edit", paths: ["src/**"] },
            decision: "allow",
            createdBy: human,
            createdAt: at,
          },
        },
      ],
    ] as const)
      test.store.dispatch(commandId, (state) =>
        handle(state, command, { commandId, at, actor: human }),
      );
    test.queue("input", "file_approval");
    await manager.ensure("thread");
    await expect.poll(() => test.store.snapshot().interaction?.[0]?.state).toBe("answered");
    await expect
      .poll(() => test.store.snapshot().turn?.some((turn) => turn.status === "completed"))
      .toBe(true);
    const request = test.store.snapshot().interaction?.[0];
    expect(request).toMatchObject({
      context: { toolKind: "edit", paths: ["[redacted]/src/a.ts"] },
      resolution: { action: "accept", choice: "allow_once", automatic: true },
    });
    expect(
      test.store
        .snapshot()
        .audit?.some(
          (row) =>
            row.action === "interaction.answer" &&
            (row.detail as Record<string, unknown>)?.ruleId === "allow-src",
        ),
    ).toBe(true);
    if (!native) throw new Error("missing_native_process");
    expect(readFileSync(native.process.frameFile, "utf8")).not.toContain(
      path.join(test.root, "src/a.ts"),
    );
  } finally {
    await manager.close();
    await engine.stopTimers();
    test.close();
  }
});
