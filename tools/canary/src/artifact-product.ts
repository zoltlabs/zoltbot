import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeDefinitions } from "../../../packages/adapters/claude/src/definitions.js";
import { codexDefinitions } from "../../../packages/adapters/codex/src/definitions.js";
import { startDaemon } from "../../../packages/daemon/src/api.js";
import { blobBytes } from "../../../packages/daemon/src/artifacts/intake.js";
import { artifactDirectory, versionDetail } from "../../../packages/daemon/src/artifacts/model.js";
import { productionRuntime } from "../../../packages/daemon/src/production-runtime.js";
import { DaemonClient } from "../../../packages/ui/src/connection.js";

// Live, two turns per installed provider, production save/storage; no publishing or external content.
const root = path.resolve(`.cache/artifact-product-${Date.now()}`);
mkdirSync(root, { recursive: true });
const daemon = await startDaemon({
  dataDir: root,
  runtime: (context) => productionRuntime(context, root),
});
const client = new DaemonClient(async () => ({ url: daemon.url, token: daemon.token }));
const results: {
  provider: string;
  version: unknown;
  versions: number;
  hashes: string[];
  passed: boolean;
  error: string | undefined;
}[] = [];
let n = 0;
const call = (method: string, params: unknown) =>
  client.call(method, params, `artifact-product-${++n}`);
async function settle(threadId: string, expected: number) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    for (const request of daemon.store.snapshot(["interaction"]).interaction ?? []) {
      if (request.threadId !== threadId || request.state !== "pending") continue;
      if (
        !["approval", "form"].includes(String(request.type)) ||
        !JSON.stringify(request).includes("team_artifact")
      )
        throw Error("unexpected_interactive_request");
      await call("interaction.answer", {
        id: request.id,
        version: request.version,
        answer: {
          action: "accept",
          ...(request.type === "form"
            ? { answers: { form: { value: {} } } }
            : { choice: "allow_once" }),
          by: { kind: "human", id: "artifact-canary" },
          at: new Date().toISOString(),
        },
      });
    }
    const turns = (daemon.store.snapshot(["turn"]).turn ?? []).filter(
      (t) => t.threadId === threadId,
    );
    if (turns.some((t) => t.status === "failed")) throw Error("native_turn_failed");
    if (turns.filter((t) => t.status === "completed").length >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error("canary_timeout");
}
try {
  await client.start();
  for (const definition of [claudeDefinitions[0], codexDefinitions[0]]) {
    if (!definition) continue;
    const provider = definition.id,
      threadId = `artifact-${provider}`;
    const result = {
      provider,
      version: undefined as unknown,
      versions: 0,
      hashes: [] as string[],
      passed: false,
      error: undefined as string | undefined,
    };
    try {
      daemon.dispatch(
        { type: "create", kind: "agentDefinition", value: definition },
        `seed-${provider}`,
      );
      daemon.dispatch(
        {
          type: "create",
          kind: "agent",
          value: {
            id: provider,
            name: definition.displayName,
            avatar: "A",
            kind: "profile",
            definitionId: provider,
            permissionProfile: "read_only",
            instructions: "",
            hidden: false,
            archived: false,
          },
        },
        `profile-${provider}`,
      );
      const at = new Date().toISOString();
      daemon.dispatch(
        {
          type: "create",
          kind: "thread",
          value: {
            id: threadId,
            agentId: provider,
            kind: "main",
            title: "Local artifact canary",
            titleSource: "human",
            pinned: false,
            archived: false,
            createdAt: at,
            lastActivityAt: at,
          },
        },
        `thread-${provider}`,
      );
      await call("session.connect", { threadId });
      for (const version of [1, 2]) {
        const html = `<!doctype html><html lang="en"><title>Local canary</title><h1>Local canary version ${version}</h1></html>`;
        await call("turn.send", {
          threadId,
          mode: "queue",
          input: [
            {
              type: "text",
              text: `Local product acceptance fixture. Call team_artifact exactly once with action=save, key=local-canary, title=Local canary, kind=page, source.files=[{path:"index.html",text:${JSON.stringify(html)}}]. Reuse the key. Use inline mode; do not run shell commands or access network. Then reply Saved.`,
            },
          ],
        });
        await settle(threadId, version);
        const artifact = (daemon.store.snapshot(["artifact"]).artifact ?? []).find(
          (a) => a.threadId === threadId && a.key === "local-canary",
        );
        if (!artifact) throw Error("artifact_not_saved");
        const detail = versionDetail(daemon.store, String(artifact.currentVersionId));
        const file = detail.manifest.files.find((f) => f.path === "index.html");
        if (
          !file ||
          (await blobBytes(artifactDirectory(daemon.store), file.hash)).toString() !== html
        )
          throw Error("artifact_bytes_mismatch");
        result.hashes.push(
          String(
            daemon.store.record("artifactVersion", String(artifact.currentVersionId))?.manifestHash,
          ),
        );
      }
      result.versions = (daemon.store.snapshot(["artifactVersion"]).artifactVersion ?? []).filter(
        (v) =>
          v.sessionId ===
          (daemon.store.snapshot(["session"]).session ?? []).find((s) => s.threadId === threadId)
            ?.id,
      ).length;
      result.version =
        (daemon.store.snapshot(["session"]).session ?? []).find((s) => s.threadId === threadId)
          ?.providerVersion ?? "unreported";
      result.passed = result.versions === 2 && result.hashes[0] !== result.hashes[1];
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      result.error = /^[a-z_]+$/.test(message) ? message : "provider_or_runtime_error";
    }
    results.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  writeFileSync(path.join(root, "receipt.json"), `${JSON.stringify({ results }, null, 2)}\n`);
  client.stop();
  await daemon.close();
}
if (results.some((r) => !r.passed)) process.exitCode = 1;
