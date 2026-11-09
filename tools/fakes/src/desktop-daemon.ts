import path from "node:path";
import type { Command } from "@zoltbot/core";
import { startDaemon } from "@zoltbot/daemon";

const dataDir = process.env.ZOLTBOT_DATA_DIR;
if (!dataDir) throw new Error("Test data directory required");
const daemon = await startDaemon({
  dataDir,
  ...(process.env.ZOLTBOT_UI_ORIGIN
    ? { origins: ["zoltbot://desktop", process.env.ZOLTBOT_UI_ORIGIN] }
    : {}),
});
const at = "2026-10-27T12:00:00.000Z";
const records: [string, Record<string, unknown>][] = [
  [
    "agentDefinition",
    {
      id: "reference",
      displayName: "Reference",
      adapter: "reference",
      binaryNames: ["node"],
      versionCommand: ["--version"],
      launch: { command: "node", args: [], env: {} },
      testedVersions: "test-1",
      defaults: { permissionProfile: "workspace_write" },
      staticCapabilities: {},
      nativeSessionRoots: [],
      experimental: false,
    },
  ],
  [
    "agent",
    {
      id: "p",
      name: "Builder",
      avatar: "B",
      definitionId: "reference",
      kind: "profile",
      permissionProfile: "workspace_write",
      instructions: "",
      hidden: false,
      archived: false,
    },
  ],
  [
    "project",
    {
      id: "project",
      name: "Example project",
      goal: "Build a useful tool",
      instructions: "",
      constraints: "",
      roots: [{ path: path.resolve("."), label: "Repository" }],
      hierarchyDepth: 0,
      tags: [],
      requireCodeReview: false,
      skipFinalGateWhenReviewed: false,
      archived: false,
      createdAt: at,
    },
  ],
  [
    "thread",
    {
      id: "h",
      agentId: "p",
      kind: "main",
      title: "Shell verification",
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    },
  ],
  [
    "interaction",
    {
      id: "i",
      agentId: "p",
      threadId: "h",
      type: "question",
      version: 1,
      state: "pending",
      urgency: "blocking",
      items: [{ id: "q", prompt: "Continue testing?" }],
      chain: [],
      createdAt: at,
    },
  ],
];
for (const [index, [kind, value]] of records.entries())
  if (!daemon.store.snapshot()[kind]?.length)
    daemon.dispatch({ type: "create", kind, value } as Command, `fixture:${index}`);
setTimeout(() => {
  const current = daemon.store.snapshot().interaction?.[0];
  if (current?.state === "pending")
    daemon.dispatch(
      {
        type: "answer",
        id: "i",
        version: Number(current.version),
        answer: { action: "accept", by: { kind: "human", id: "test-owner" }, at },
      },
      "fixture:resolve",
    );
}, 12_000);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void daemon.close().then(() => {
      process.exitCode = 0;
    });
  });
