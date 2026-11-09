import { readFileSync } from "node:fs";
import path from "node:path";
import type { startDaemon } from "@zoltbot/daemon";
import { artifactTemplate } from "../../../packages/artifact-kit/src/index.js";
import { createArtifactBinding } from "../../../packages/daemon/src/artifacts/binding.js";
import { saveArtifact } from "../../../packages/daemon/src/artifacts/save.js";
import { PrivateInputGuard } from "../../../packages/daemon/src/private-input.js";
import { hostileArtifact, hostileSvg } from "../../../tests/artifacts/hostile.js";

/** UI fixture only; provider host transport is covered by separate production-runtime tests. */
export async function seedArtifactViewer(
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  dataDir: string,
) {
  const at = "2026-11-05T12:00:00Z",
    id = "artifact-fixture-session";
  daemon.dispatch(
    {
      type: "create",
      kind: "session",
      value: {
        id,
        threadId: "h",
        provider: "reference",
        cwd: dataDir,
        state: "starting",
        capabilities: {},
        startedAt: at,
      },
    },
    "artifact-fixture:session",
  );
  daemon.dispatch(
    { type: "transition", kind: "session", id, to: "ready" },
    "artifact-fixture:ready",
  );
  daemon.dispatch(
    { type: "transition", kind: "session", id, to: "running" },
    "artifact-fixture:running",
  );
  daemon.dispatch(
    {
      type: "create",
      kind: "turn",
      value: {
        id: "artifact-fixture-turn",
        sessionId: id,
        threadId: "h",
        status: "running",
        origin: "human",
        startedAt: at,
      },
    },
    "artifact-fixture:turn",
  );
  daemon.dispatch(
    {
      type: "create",
      kind: "settings",
      value: {
        key: `runtime.configuration.${id}`,
        value: {
          launchManifest: {
            artifact: createArtifactBinding(path.join(dataDir, "artifact-workspace")),
          },
        },
      },
    },
    "artifact-fixture:configuration",
  );
  daemon.dispatch(
    {
      type: "create",
      kind: "item",
      value: {
        id: "artifact-fixture-explanation",
        threadId: "h",
        turnId: "artifact-fixture-turn",
        seq: 10000,
        kind: "message",
        phase: "final",
        body: { text: "These offline visuals illustrate the artifact preview boundary." },
        createdAt: at,
        updatedAt: at,
      },
    },
    "artifact-fixture:explanation",
  );
  const context = {
    store: daemon.store,
    privacy: new PrivateInputGuard({ store: daemon.store, publish() {} }),
    publish() {},
    async wake() {},
  };
  const actor = { agentId: "p", threadId: "h", sessionId: id, turnId: "artifact-fixture-turn" };
  const sink = process.env.ZOLTBOT_ARTIFACT_SINK ?? "http://127.0.0.1:9";
  const save = async (key: string, kind: "page" | "diagram", text: string, file = "index.html") =>
    saveArtifact(context, {
      actor,
      idempotencyKey: key,
      arguments: {
        key,
        kind,
        title: key === "hostile" ? "Hostile fixture" : "SVG fixture",
        source: { files: [{ path: file, text }] },
      },
    });
  await save("hostile", "page", hostileArtifact(sink));
  const starter = artifactTemplate("metrics");
  await saveArtifact(context, {
    actor,
    idempotencyKey: "kit",
    arguments: {
      key: "kit",
      title: "Kit fixture",
      kind: "chart",
      source: { files: starter.files },
      kit: starter.kit,
    },
  });
  await save("svg", "diagram", hostileSvg, "image.svg");
  await saveArtifact(context, {
    actor,
    idempotencyKey: "document",
    arguments: {
      key: "document",
      kind: "document",
      title: "Document fixture",
      source: {
        files: [
          {
            path: "document.md",
            text: `# Document fixture\n\n**Readable** content.\n\n![Remote image](${sink}/markdown-image)\n\n<script>window.documentScriptRan=true</script>`,
          },
        ],
      },
    },
  });
  await saveArtifact(context, {
    actor,
    idempotencyKey: "image",
    arguments: {
      key: "image",
      kind: "image",
      title: "Image fixture",
      source: {
        files: [
          {
            path: "image.png",
            base64: readFileSync(path.resolve("fixtures/browser/local-form.png")).toString(
              "base64",
            ),
          },
        ],
      },
    },
  });
  await saveArtifact(context, {
    actor,
    idempotencyKey: "bundle",
    arguments: {
      key: "bundle",
      kind: "page",
      title: "Bundle fixture",
      source: {
        files: [
          {
            path: "index.html",
            text: '<!doctype html><link rel="stylesheet" href="style.css"><h1>Bundle fixture</h1><output id="data">Loading</output><script src="app.js"></script>',
          },
          { path: "style.css", text: "h1{color:rgb(10, 20, 30)}" },
          {
            path: "app.js",
            text: 'fetch("data.json").then(r=>r.json()).then(data=>document.getElementById("data").textContent=data.message)',
          },
          { path: "data.json", text: '{"message":"Bundle data loaded"}' },
        ],
      },
    },
  });
}
