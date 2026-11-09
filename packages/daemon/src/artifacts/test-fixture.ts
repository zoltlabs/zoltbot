import { mkdir } from "node:fs/promises";
import path from "node:path";
import { type Command, handle } from "@zoltbot/core";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "../private-input.js";
import { createArtifactBinding } from "./binding.js";
import { saveArtifact } from "./save.js";
export async function artifactFixture() {
  const f = await runtimeFixture();
  const workspace = path.join(f.root, "project");
  await mkdir(workspace);
  let n = 0;
  const change = (command: Command) => {
    const commandId = `artifact-fixture:${++n}`;
    return f.store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "fixture" } }),
    ).result;
  };
  change({
    type: "create",
    kind: "project",
    value: {
      id: "artifact-project",
      name: "Artifact fixture",
      goal: "",
      instructions: "",
      constraints: "",
      roots: [{ path: workspace, label: "Fixture" }],
      hierarchyDepth: 3,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: at,
    },
  });
  change({
    type: "update",
    kind: "thread",
    id: "thread",
    changes: { projectId: "artifact-project" },
  });
  change({ type: "transition", kind: "session", id: "session", to: "ready" });
  change({ type: "transition", kind: "session", id: "session", to: "running" });
  change({
    type: "create",
    kind: "turn",
    value: {
      id: "turn",
      sessionId: "session",
      threadId: "thread",
      status: "running",
      origin: "human",
      startedAt: at,
    },
  });
  const binding = createArtifactBinding(workspace, workspace);
  change({
    type: "create",
    kind: "settings",
    value: {
      key: "runtime.configuration.session",
      value: { launchManifest: { artifact: binding } },
    },
  });
  const context = {
    store: f.store,
    privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
    publish() {},
    async wake() {},
  };
  const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };
  const save = (text: string, key = "sample") =>
    saveArtifact(context, {
      actor,
      idempotencyKey: `save-${++n}`,
      arguments: {
        key,
        title: "Sample",
        kind: "page",
        source: { files: [{ path: "index.html", text }] },
      },
    }) as Promise<{ artifactId: string; versionId: string; number: number }>;
  return { ...f, workspace, binding, context, actor, change, save };
}
