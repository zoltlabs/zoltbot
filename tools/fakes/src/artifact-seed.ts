import { mkdirSync } from "node:fs";
import { type Command, handle } from "@zoltbot/core";
import type { Store } from "@zoltbot/store";
import { createArtifactBinding } from "../../../packages/daemon/src/artifacts/binding.js";
import { saveArtifact } from "../../../packages/daemon/src/artifacts/save.js";
import { PrivateInputGuard } from "../../../packages/daemon/src/private-input.js";
import { at } from "./runtime-fixture.js";

/**
 * Saves Markdown artifact versions as the fixture chat ("thread"), the way an agent's
 * `team_artifact` save does, after moving that chat into `projectId`. Each text is one version.
 */
export async function seedMarkdownArtifact(
  store: Store,
  input: { projectId: string; workspace: string; title: string; texts: string[] },
) {
  let n = 0;
  const change = (command: Command) => {
    const commandId = `artifact-seed:${input.title}:${++n}`;
    return store.dispatch(commandId, (state) =>
      handle(state, command, { commandId, at, actor: { kind: "system", id: "fixture" } }),
    ).result;
  };
  mkdirSync(input.workspace, { recursive: true });
  change({ type: "update", kind: "thread", id: "thread", changes: { projectId: input.projectId } });
  // A running daemon closes the fixture's first session, so the artifacts get a session of their own.
  const sessionId = `artifact-seed-session:${input.title}`;
  change({
    type: "create",
    kind: "session",
    value: {
      id: sessionId,
      threadId: "thread",
      provider: "reference",
      cwd: input.workspace,
      state: "starting",
      capabilities: {},
      startedAt: at,
    },
  });
  change({ type: "transition", kind: "session", id: sessionId, to: "ready" });
  change({ type: "transition", kind: "session", id: sessionId, to: "running" });
  const context = {
    store,
    privacy: new PrivateInputGuard({ store, publish() {} }),
    publish() {},
    async wake() {},
  };
  const binding = createArtifactBinding(input.workspace, input.workspace);
  change({
    type: "create",
    kind: "settings",
    value: {
      key: `runtime.configuration.${sessionId}`,
      value: { launchManifest: { artifact: binding } },
    },
  });
  const saved: { artifactId: string; versionId: string; number: number }[] = [];
  for (const [index, text] of input.texts.entries()) {
    const turnId = `artifact-seed-turn-${index}`;
    change({
      type: "create",
      kind: "turn",
      value: {
        id: turnId,
        sessionId,
        threadId: "thread",
        status: "running",
        origin: "human",
        startedAt: at,
      },
    });
    saved.push(
      (await saveArtifact(context as never, {
        actor: { agentId: "profile", threadId: "thread", sessionId, turnId },
        idempotencyKey: `artifact-seed:${input.title}:${index}`,
        arguments: {
          key: "outline",
          title: input.title,
          kind: "document",
          source: { files: [{ path: "outline.md", text }] },
        },
      })) as { artifactId: string; versionId: string; number: number },
    );
  }
  return saved;
}
