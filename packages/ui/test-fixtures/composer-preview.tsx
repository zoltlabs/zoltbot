import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/chat/Composer.js";
import type { ChatConnection } from "../src/chat/types.js";
import { useShell } from "../src/state.js";
import "../src/shell/shell.css";
import "../src/chat/chat.css";

declare global {
  interface Window {
    composerFixture: {
      calls: { method: string; params: unknown; commandId?: string | undefined }[];
      fail: boolean;
      hold: boolean;
      resolve?: (() => void) | undefined;
    };
  }
}
const fixture = { calls: [], fail: false, hold: false } as Window["composerFixture"];
window.composerFixture = fixture;
function Preview() {
  const [threadId, setThreadId] = useState("composer-a");
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState(true);
  const [online, setOnline] = useState(true);
  const [artifact, setArtifact] = useState(false);
  const [mode, setMode] = useState(0);
  const [generation, setGeneration] = useState(0);
  const connection: ChatConnection = {
    status: online ? "online" : "offline",
    snapshot: {
      seq: 0,
      counters: {},
      entities: { thread: [{ id: threadId, agentId: "builder" }] },
    },
    call: async (method, params, commandId) => {
      fixture.calls.push({ method, params, commandId });
      if (method === "workspace.files")
        return {
          items: [{ path: "/synthetic/src/main.ts", label: "src/main.ts" }],
          truncated: false,
        };
      if (fixture.hold)
        await new Promise<void>((resolve) => {
          fixture.resolve = resolve;
        });
      if (fixture.fail) throw new Error("synthetic_connection_lost");
      return { ok: true };
    },
  };
  return (
    <main style={{ maxWidth: 900, margin: "40px auto", padding: 20 }}>
      <h1>Composer verification</h1>
      <nav aria-label="Synthetic controls" className="r wrap">
        <button
          type="button"
          onClick={() => setThreadId(threadId === "composer-a" ? "composer-b" : "composer-a")}
        >
          Switch conversation
        </button>
        <button type="button" onClick={() => setBusy(!busy)}>
          Toggle busy
        </button>
        <button type="button" onClick={() => setImages(!images)}>
          Toggle images
        </button>
        <button type="button" onClick={() => setOnline(!online)}>
          Toggle connection
        </button>
        <button type="button" onClick={() => setArtifact(!artifact)}>
          Toggle artifact
        </button>
        <button
          type="button"
          onClick={() => {
            useShell.setState({ chatDraft: { threadId, text: "Quick Chat handoff" } });
            setGeneration(generation + 1);
          }}
        >
          Handoff
        </button>
      </nav>
      <p>
        Conversation: {threadId} · Mode: {mode}
      </p>
      <Composer
        key={generation}
        connection={connection}
        threadId={threadId}
        name="Builder"
        busy={busy}
        steer
        images={images}
        commands={[
          { name: "compact", description: "Compact session" },
          { name: "zoltbot-review", description: "Loaded review skill" },
        ]}
        interrupt={async () => {
          fixture.calls.push({ method: "interrupt", params: {} });
        }}
        modeControl={<span>Permission mode {mode}</span>}
        onCycleMode={() => {
          setMode(mode + 1);
          return true;
        }}
        artifactTarget={
          artifact
            ? { artifactId: "synthetic-artifact", versionId: "synthetic-version" }
            : undefined
        }
        clearArtifactTarget={() => setArtifact(false)}
      />
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
