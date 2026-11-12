import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { InteractionSchema, parse } from "../../packages/protocol/src/index.js";
import Chat from "../../packages/ui/src/chat/Chat.js";
import type { ChatConnection, Row } from "../../packages/ui/src/chat/types.js";
import { useShell } from "../../packages/ui/src/state.js";
import "../../packages/ui/src/shell/shell.css";

const at = "2026-11-01T12:00:00Z";
const artifact = {
  id: "artifact",
  threadId: "thread",
  key: "mockup",
  kind: "design",
  title: "Field notes",
  currentVersionId: "v2",
  starredVersionIds: [],
  provider: "fake",
  profileId: "profile",
  state: "active",
  repositoryState: "local",
  createdAt: at,
  updatedAt: at,
};
const version = {
  id: "v1",
  artifactId: "artifact",
  number: 1,
  manifestHash: "baseline",
  totalBytes: 10,
  fileCount: 1,
  sessionId: "session",
  turnId: "turn",
  note: "Initial design",
  auto: false,
  held: false,
  metadataOnly: false,
  thumbnailState: "pending",
  thumbnails: {},
  reviewState: "unreviewed",
  createdAt: at,
};
const base: Record<string, Row[]> = {
  agent: [
    { id: "profile", name: "Designer", permissionProfile: "workspace_write", definitionId: "fake" },
  ],
  agentDefinition: [{ id: "fake", displayName: "Reference tool" }],
  thread: [
    {
      id: "thread",
      agentId: "profile",
      title: "Refresh the notes app",
      kind: "main",
      archived: false,
    },
  ],
  session: [{ id: "session", threadId: "thread", state: "ready", capabilities: {}, startedAt: at }],
  turn: [
    {
      id: "turn",
      threadId: "thread",
      sessionId: "session",
      status: "completed",
      startedAt: at,
      endedAt: "2026-11-01T12:02:00Z",
    },
  ],
  item: [
    {
      id: "user",
      threadId: "thread",
      turnId: "turn",
      kind: "user",
      seq: 1,
      body: { text: "Give the notes app a calmer layout." },
      createdAt: at,
    },
    {
      id: "commentary",
      threadId: "thread",
      turnId: "turn",
      kind: "message",
      phase: "commentary",
      seq: 1.5,
      body: { text: "The existing sidebar is too dense. I’ll simplify it.", streaming: false },
      createdAt: at,
    },
    {
      id: "edit",
      threadId: "thread",
      turnId: "turn",
      kind: "tool",
      seq: 2,
      body: {
        kind: "edit",
        name: "Edit",
        status: "ok",
        diffs: [{ path: "src/notes.tsx", patch: "@@ -1 +1 @@\n-old\n+new" }],
      },
      createdAt: at,
    },
    {
      id: "reply",
      threadId: "thread",
      turnId: "turn",
      kind: "message",
      phase: "final",
      seq: 3,
      body: {
        text: "Updated the spacing and simplified the first screen. Two versions are ready to compare.\n\n[Preview](https://example.invalid/preview)",
        streaming: false,
      },
      createdAt: at,
    },
  ],
  artifact: [artifact],
  artifactVersion: [
    version,
    { ...version, id: "v2", number: 2, manifestHash: "alternative", note: "Revised layout" },
  ],
  settings: [
    {
      key: "runtime.configuration.session",
      value: { launchManifest: { artifact: { sourceRead: 1 } } },
    },
  ],
};
const calls: { method: string; params: unknown }[] = [];
Object.assign(window, { resultsFixture: { calls } });
window.zoltDesktop = {
  connection: async () => ({ url: "", token: "" }),
  onConnectionChanged: () => () => {},
  prepareArtifact: async () => ({ url: location.origin }),
  openExternal: async () => {},
};
function Fixture() {
  const [state, setState] = useState("online");
  const [archived, setArchived] = useState(false);
  const entities = structuredClone(base);
  const session = entities.session?.[0];
  if (entities.thread?.[0]) entities.thread[0].archived = archived;
  if (session && state === "terminal") session.cwd = "/workspace/example";
  if (session && state === "limited")
    session.runtimeStatus = {
      state: "rate_limited",
      resetsAt: "2026-11-02T16:00:00Z",
      observedAt: at,
    };
  if (session && state === "reconnecting")
    session.runtimeStatus = { state: "reconnecting", observedAt: at };
  if (session && state === "background")
    session.background = [
      { id: "job", kind: "task", description: "Build preview", state: "running" },
    ];
  if (state === "failed" && entities.turn?.[0]) entities.turn[0].status = "failed";
  if (state === "uncertain" && entities.item?.[0])
    entities.item[0].body = { text: "Saved message", queueState: "uncertain" };
  if (state === "pending")
    entities.interaction = [
      {
        id: "request",
        threadId: "thread",
        agentId: "profile",
        type: "question",
        state: "pending",
        title: "Choose a direction",
        items: [
          {
            id: "choice",
            prompt: "Which layout?",
            options: [{ id: "a", label: "Compact" }],
            allowOther: true,
          },
        ],
        context: {},
        chain: [],
        urgency: "blocking",
        version: 1,
        createdAt: at,
      },
    ];
  if (state === "running" && entities.turn?.[0]) {
    entities.turn[0].status = "running";
    delete entities.turn[0].endedAt;
    entities.item = entities.item?.filter((item) => item.id !== "reply");
    const edit = entities.item?.find((item) => item.id === "edit");
    if (edit) edit.body = { ...(edit.body as Row), status: "running" };
  }
  if (state === "approval")
    entities.interaction = [
      {
        id: "approval",
        threadId: "thread",
        agentId: "profile",
        type: "approval",
        state: "pending",
        title: "Read project files?",
        items: [
          {
            id: "tool",
            prompt: "Read the project files",
            choices: [
              { id: "allow_once", label: "Read once" },
              { id: "allow_session", label: "Read project files" },
            ],
          },
        ],
        context: { toolName: "Read", toolKind: "read" },
        urgency: "blocking",
        version: 1,
        createdAt: at,
        chain: [],
      },
    ];
  for (const request of entities.interaction ?? []) parse(InteractionSchema, request);
  const connection: ChatConnection = {
    status: state === "offline" ? "offline" : "online",
    snapshot: { seq: 1, counters: {}, entities },
    call: async (method, params) => {
      calls.push({ method, params });
      if (method === "artifact.get") {
        const request = params as { versionId: string };
        const selected =
          entities.artifactVersion?.find((row) => row.id === request.versionId) ?? version;
        const entry = `tests/results/${selected.number === 1 ? "baseline" : "alternative"}.html`;
        return {
          artifact,
          version: selected,
          manifest: {
            version: 1,
            entry,
            files: [],
            screens: [{ id: "home", title: "Home", path: entry, width: 640, height: 480 }],
          },
          saveChecks: [],
        };
      }
      if (method === "terminal.list") return { items: [] };
      if (method === "thread.settle") setArchived(true);
      return {};
    },
  };
  return (
    <main className="zb" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <label style={{ padding: 8 }}>
        Fixture state{" "}
        <select value={state} onChange={(event) => setState(event.target.value)}>
          {[
            "online",
            "running",
            "terminal",
            "approval",
            "limited",
            "reconnecting",
            "background",
            "pending",
            "offline",
            "failed",
            "uncertain",
          ].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Chat connection={connection} threadId="thread" />
      </div>
    </main>
  );
}
if (new URLSearchParams(location.search).has("handoff"))
  useShell.setState({ chatDraft: { threadId: "thread", text: "Review this handoff." } });
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Fixture />
    </StrictMode>,
  );
