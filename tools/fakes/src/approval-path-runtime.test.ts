import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import type { Interaction } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { ReferenceSession } from "./reference-adapter.js";
import { runtimeFixture } from "./runtime-fixture.js";

it("verifies approval paths against the owned native cwd and ignores the request's claimed cwd", async () => {
  const test = await runtimeFixture();
  const workspace = path.join(test.root, "workspace");
  const outside = path.join(test.root, "outside");
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  mkdirSync(outside);
  const cwd = path.join(test.root, "workspace-alias");
  symlinkSync(workspace, cwd);
  const manager = new SessionManager({
    store: test.store,
    publish() {},
    host: {
      async prepare(_input, redactor) {
        return {
          cwd,
          estimate: (text) => text.length,
          open: async (request) =>
            new ReferenceSession(
              {
                identity: { agentId: "profile", threadId: "thread" },
                mode: request.mode,
                cwd,
                permissionProfile: "read_only",
                hostMcp: { url: "http://127.0.0.1:1", token: "synthetic" },
              },
              undefined,
              300,
              redactor,
            ).open(),
        };
      },
    },
  });
  const interaction: Interaction = {
    id: "approval",
    agentId: "profile",
    threadId: "thread",
    type: "approval",
    state: "pending",
    version: 1,
    context: { toolName: "Write", toolKind: "edit", cwd: outside, paths: ["src/new.ts"] },
    items: [{ id: "operation", prompt: "Allow edit?", choices: [{ id: "allow_once" }] }],
    chain: [],
    urgency: "blocking",
    createdAt: new Date().toISOString(),
  };
  try {
    test.store.dispatch("close-seed-session", (state) =>
      handle(
        state,
        {
          type: "transition",
          kind: "session",
          id: "session",
          to: "closed",
        },
        {
          commandId: "close-seed-session",
          at: new Date().toISOString(),
          actor: { kind: "system", id: "runtime" },
        },
      ),
    );
    await manager.ensure("thread");
    expect(manager.interactionHost.approvalPaths?.(interaction)).toBeUndefined();
    expect(
      manager.interactionHost.approvalPaths?.(interaction, interaction.context?.paths),
    ).toEqual(["src/new.ts"]);
    expect(
      manager.interactionHost.approvalPaths?.(
        {
          ...interaction,
          context: { ...interaction.context, paths: [path.join(outside, "target.ts")] },
        },
        [path.join(outside, "target.ts")],
      ),
    ).toBeUndefined();
    rmSync(cwd);
    symlinkSync(outside, cwd);
    expect(
      manager.interactionHost.approvalPaths?.(interaction, interaction.context?.paths),
    ).toBeUndefined();
    rmSync(cwd);
    symlinkSync(workspace, cwd);
    const moved = path.join(test.root, "moved-workspace");
    renameSync(workspace, moved);
    mkdirSync(workspace);
    expect(
      manager.interactionHost.approvalPaths?.(interaction, interaction.context?.paths),
    ).toBeUndefined();
    rmSync(workspace, { recursive: true });
    renameSync(moved, workspace);
    await manager.close();
    expect(() =>
      manager.interactionHost.approvalPaths?.(interaction, interaction.context?.paths),
    ).toThrow("interaction_runtime_unavailable");
  } finally {
    await manager.close();
    test.close();
  }
});
