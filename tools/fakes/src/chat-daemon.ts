import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { startDaemon } from "@zoltbot/daemon";
import { type EntityKind, parseEvent } from "@zoltbot/protocol";
import { knowledgeWrites } from "../../../packages/daemon/src/knowledge-writes.js";
import { PrivateInputGuard } from "../../../packages/daemon/src/private-input.js";
import { KeychainSecrets } from "../../../packages/daemon/src/secrets.js";
import { referenceBrowser } from "./browser-runtime.js";
import { referenceCapabilities } from "./capabilities.js";
import { referenceKnowledge } from "./knowledge-runtime.js";
import { ReferenceSession } from "./reference-adapter.js";

const dataDir = process.env.ZOLTBOT_DATA_DIR;
if (!dataDir) throw new Error("fixture_data_dir_required");
mkdirSync(dataDir, { recursive: true });
let native: ReferenceSession | undefined;
const privateValues = new Map<string, string>();
const daemon = await startDaemon({
  dataDir,
  routineClock: () => {
    const clockFile = path.join(dataDir, "routine-clock.txt");
    return existsSync(clockFile)
      ? readFileSync(clockFile, "utf8").trim()
      : new Date().toISOString();
  },
  routinePollMs: 100,
  secrets: new KeychainSecrets(async (request) => {
    if (request.op === "put") {
      privateValues.set(request.account, request.value ?? "");
      return { ok: true };
    }
    return { ok: true, value: privateValues.get(request.account) };
  }),
  ...(process.env.ZOLTBOT_UI_ORIGIN
    ? { origins: ["zoltbot://desktop", process.env.ZOLTBOT_UI_ORIGIN] }
    : {}),
  runtimeHost: {
    async prepare(input, redactor) {
      redactor.register("synthetic-private-live-value");
      redactor.hideFrames();
      const knowledge = referenceKnowledge(daemon.store, input, dataDir);
      const browser = referenceBrowser(
        daemon.store,
        input,
        dataDir,
        ("configuration" in knowledge ? knowledge.configuration : undefined) as
          | {
              launchManifest: import("../../../packages/connections/src/launch-manifest.js").LaunchManifest;
            }
          | undefined,
      );
      return {
        cwd: dataDir,
        estimate: (text) => text.length,
        ...knowledge,
        ...(browser ? { configuration: browser.configuration } : {}),
        async open(request) {
          browser?.register(request.sessionId);
          native = await new ReferenceSession(
            {
              identity: { agentId: input.profile.id, threadId: input.thread.id },
              cwd: dataDir,
              mode: request.mode,
              ...(request.nativeId ? { nativeId: request.nativeId } : {}),
              permissionProfile: "read_only",
              env: { REFERENCE_NATIVE_ID: input.thread.id },
              hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
            },
            undefined,
            15000,
            redactor,
          ).open();
          const session = native;
          if (browser)
            return new Proxy(session, {
              get(target, property) {
                if (property === "send")
                  return async (...args: Parameters<typeof session.send>) => {
                    browser.register(request.sessionId);
                    return session.send(...args);
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          return native;
        },
      };
    },
  },
});
const at = "2026-10-28T12:00:00Z";
const rows: [EntityKind, Record<string, unknown>][] = [
  [
    "agentDefinition",
    {
      id: "reference",
      displayName: "Reference coding tool",
      adapter: "reference",
      binaryNames: [],
      versionCommand: [],
      launch: { command: "fake", args: [], env: {} },
      testedVersions: "fixture",
      defaults: { permissionProfile: "read_only" },
      staticCapabilities: referenceCapabilities,
      nativeSessionRoots: [],
      experimental: false,
    },
  ],
  [
    "agent",
    {
      id: "p",
      definitionId: "reference",
      name: "Builder",
      avatar: "B",
      kind: "profile",
      permissionProfile:
        process.env.ZOLTBOT_BROWSER_FIXTURE === "1" ? "workspace_write" : "read_only",
      instructions: "",
      hidden: false,
      archived: false,
    },
  ],
  [
    "thread",
    {
      id: "h",
      agentId: "p",
      kind: "main",
      title: "Chat verification",
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    },
  ],
];
for (const [kind, value] of rows)
  if (!daemon.store.snapshot()[kind]?.some((row) => row.id === value.id))
    daemon.dispatch({ type: "create", kind, value }, `fixture:${kind}`);
if (process.env.ZOLTBOT_CHIEF_FIXTURE === "1") {
  const { seedChief } = await import("./chief-fixture.js");
  seedChief(daemon, at);
}
if (process.env.ZOLTBOT_ARTIFACT_FIXTURE === "1") {
  const { seedArtifactViewer } = await import("./artifact-viewer-fixture.js");
  await seedArtifactViewer(daemon, dataDir);
}
const count = Number(process.env.ZOLTBOT_TEST_HISTORY_ITEMS ?? 60);
if (!daemon.store.snapshot().item?.length)
  daemon.store.dispatch("fixture:history", () => ({
    events: Array.from({ length: count }, (_, index) => {
      let kind = "message",
        body: Record<string, unknown> = {
          text: `Saved message ${index + 1}. Keep the work clear, check the result, and preserve native history.`,
        };
      if (index % 2) {
        kind = "user";
        body = {
          input: [{ type: "text", text: `Saved request ${index + 1}` }],
          queueState: "sent",
        };
      }
      if (index === count - 6) {
        kind = "thought";
        body = { text: "Compare the two options before editing." };
      }
      if (index === count - 5) {
        kind = "tool";
        body = {
          name: "Edit",
          kind: "edit",
          status: "ok",
          input: { path: "src/greeting.ts" },
          output: "Updated the greeting",
          diffs: [
            {
              path: "src/greeting.ts",
              patch:
                "@@ -1 +1 @@\n-export const greeting = 'old';\n+export const greeting = 'hello';",
            },
          ],
        };
      }
      if (index === count - 4) {
        kind = "plan";
        body = {
          entries: [
            { step: "Inspect the existing flow", status: "completed" },
            { step: "Implement the greeting", status: "completed" },
            { step: "Check the result", status: "in_progress" },
          ],
        };
      }
      if (index === count - 3) {
        kind = "message";
        body = {
          text: "## A clear result\n\nUse **small changes** and verify them.\n\n```ts\nexport const greeting = 'hello';\n```\n\n| Check | Result |\n| --- | --- |\n| Types | Passed |\n\n<img src=x onerror=window.fixtureUnsafe=true>",
        };
      }
      if (index === count - 2) {
        kind = "note";
        body = {
          code: "context_compacted",
          trigger: "manual",
          tokensBefore: 1000,
          tokensAfter: 100,
        };
      }
      if (index === count - 1) {
        kind = "message";
        body = { text: "Ready to work." };
      }
      const id = `history:${String(index).padStart(6, "0")}`;
      return parseEvent({
        eventId: `fixture:item:${index}`,
        commandId: "fixture:history",
        aggregateType: "item",
        aggregateId: id,
        type: "item.created",
        occurredAt: at,
        payload: { id, threadId: "h", seq: index + 1, kind, body, createdAt: at, updatedAt: at },
      });
    }),
    result: { count },
  }));
// WP-59 e2e: write knowledge as a session's agent through the real write policy. The host MCP
// route is covered by unit tests; the reference provider has no host connection.
const agentWrites =
  process.env.ZOLTBOT_KNOWLEDGE_FIXTURE === "1"
    ? knowledgeWrites({
        store: daemon.store,
        privacy: new PrivateInputGuard({ store: daemon.store, publish() {} }),
        publish() {},
        async wake() {},
      })
    : undefined;
const writeDir: string = dataDir;
async function agentWrite() {
  const request = JSON.parse(
    readFileSync(path.join(writeDir, "knowledge-agent-write.json"), "utf8"),
  );
  const thread = daemon.store.record("thread", String(request.threadId));
  const session = (daemon.store.snapshot(["session"]).session ?? []).findLast(
    (row) => row.threadId === request.threadId,
  );
  if (!agentWrites || !thread || !session)
    throw new Error(
      `fixture_session_missing:${!!agentWrites}:${!!thread}:${!!session}:${request.threadId}`,
    );
  const result = await agentWrites.write(
    { agentId: String(thread.agentId), threadId: String(thread.id), sessionId: String(session.id) },
    request.arguments,
    "tool",
  );
  writeFileSync(path.join(writeDir, "knowledge-agent-write.result.json"), JSON.stringify(result));
}
let advanced = 0;
let advancing = Promise.resolve();
const watcher = watch(dataDir, (_event, file) => {
  if (String(file) === "knowledge-agent-write.json") {
    agentWrite().catch((error) =>
      writeFileSync(
        path.join(writeDir, "knowledge-agent-write.result.json"),
        JSON.stringify({ error: String((error as Error).message) }),
      ),
    );
    return;
  }
  if (String(file) !== "advance-stream") return;
  try {
    const value = Number(readFileSync(path.join(dataDir, "advance-stream"), "utf8"));
    if (!Number.isInteger(value) || value < 0 || value > 2) return;
    advancing = advancing.then(async () => {
      while (advanced < value) {
        await native?.advanceStream();
        advanced += 1;
      }
    });
  } catch {}
});
watcher.unref();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    watcher.close();
    void daemon.close().then(() => {
      process.exitCode = 0;
    });
  });
