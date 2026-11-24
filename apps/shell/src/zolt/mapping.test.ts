// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Row, Snapshot } from "./daemon-client";
import { agentProfiles, latestPlan, toMessages } from "./mapping";

const HASH = "a".repeat(64);
const at = (minute: number) => `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`;

function snapshot(entities: Record<string, Row[]>): Snapshot {
  return { seq: 1, entities, counters: {} };
}

const items: Row[] = [
  {
    id: "u1",
    threadId: "t",
    seq: 1,
    kind: "user",
    turnId: "turn1",
    createdAt: at(0),
    body: { input: [{ type: "text", text: "Make a report" }] },
  },
  {
    id: "m1",
    threadId: "t",
    seq: 2,
    kind: "message",
    turnId: "turn1",
    phase: "commentary",
    createdAt: at(1),
    body: { text: "Working on it" },
  },
  {
    id: "m2",
    threadId: "t",
    seq: 3,
    kind: "message",
    turnId: "turn1",
    createdAt: at(2),
    body: { text: "Here is the report" },
  },
];

const artifact = (id: string, extra: Row = {}): Row => ({
  id,
  threadId: "t",
  kind: "document",
  title: `Title ${id}`,
  state: "active",
  ...extra,
});
const version = (id: string, artifactId: string, turnId: string, extra: Row = {}): Row => ({
  id,
  artifactId,
  turnId,
  number: 1,
  manifestHash: HASH,
  metadataOnly: false,
  held: false,
  createdAt: at(3),
  ...extra,
});

describe("toMessages artifacts", () => {
  it("puts a turn's latest artifact version under its final reply", () => {
    const messages = toMessages(
      snapshot({
        turn: [{ id: "turn1", threadId: "t", status: "completed" }],
        artifact: [artifact("a1")],
        artifactVersion: [
          version("v1", "a1", "turn1"),
          version("v2", "a1", "turn1", { number: 2 }),
        ],
      }),
      "t",
      items,
    );
    expect(messages.map((message) => message.id)).toEqual(["u1", "m1", "m2"]);
    expect(messages[1]?.artifacts).toBeUndefined();
    expect(messages[2]?.artifacts).toEqual([
      {
        id: "a1",
        versionId: "v2",
        title: "Title a1",
        kind: "document",
        version: 2,
        manifestHash: HASH,
      },
    ]);
  });

  it("skips archived and other threads' artifacts and marks unavailable files", () => {
    const messages = toMessages(
      snapshot({
        artifact: [
          artifact("a1"),
          artifact("a2", { state: "archived" }),
          artifact("a3", { threadId: "other" }),
        ],
        artifactVersion: [
          version("v1", "a1", "turn1", { metadataOnly: true }),
          version("v2", "a2", "turn1"),
          version("v3", "a3", "turn1"),
        ],
      }),
      "t",
      items,
    );
    expect(messages.at(-1)?.artifacts).toEqual([
      expect.objectContaining({ id: "a1", manifestHash: null }),
    ]);
  });

  it("adds an empty agent message when the turn has no reply", () => {
    const messages = toMessages(
      snapshot({
        artifact: [artifact("a1")],
        artifactVersion: [version("v1", "a1", "turn2", { createdAt: at(9) })],
      }),
      "t",
      items,
    );
    const carrier = messages.at(-1);
    expect(carrier).toMatchObject({
      id: "artifacts:turn2",
      author: "assistant",
      text: "",
      status: "completed",
    });
    expect(carrier?.artifacts?.map((summary) => summary.id)).toEqual(["a1"]);
  });
});

describe("latestPlan", () => {
  const plan = (id: string, entries: unknown, parentItemId?: string) => ({
    id,
    kind: "plan",
    body: { entries, ...(parentItemId ? { parentItemId } : {}) },
  });

  it("reads the newest top-level plan and skips a subagent's plan", () => {
    const items = [
      plan("old", [{ step: "Old step", status: "completed" }]),
      plan("new", [
        { step: "Read the notes", status: "completed" },
        { step: "Draft the summary", status: "in_progress" },
        { step: "  ", status: "pending" },
        { step: "Check the links", status: "unknown" },
      ]),
      plan("child", [{ step: "Subagent step", status: "pending" }], "tool-1"),
    ];
    expect(latestPlan(items)).toEqual([
      { step: "Read the notes", status: "completed" },
      { step: "Draft the summary", status: "in_progress" },
      { step: "Check the links", status: "pending" },
    ]);
  });

  it("is empty without a plan or with malformed entries", () => {
    expect(latestPlan([])).toEqual([]);
    expect(latestPlan([plan("bad", "not a list")])).toEqual([]);
  });
});

describe("compaction notes", () => {
  it("shows a finished compaction as a Compacted line", () => {
    const messages = toMessages(snapshot({}), "thread", [
      {
        id: "compact",
        threadId: "thread",
        kind: "note",
        seq: 1,
        createdAt: at(1),
        body: {
          code: "context_compacted",
          trigger: "manual",
          tokensBefore: 1000,
          tokensAfter: 100,
        },
      },
    ]);
    expect(messages).toEqual([
      expect.objectContaining({ id: "compact", source: "system", text: "Compacted" }),
    ]);
  });
});

describe("gate prompts", () => {
  it("offers a gate's own choices, like the browser's Hand back, instead of Approve and Decline", async () => {
    const { toPrompt, toResolution } = await import("./mapping");
    const card = {
      type: "gate",
      title: "You’re in control of the browser",
      items: [
        {
          id: "choice",
          prompt: "Research waits until you hand it back.",
          options: [{ id: "hand-back", label: "Hand back" }],
        },
      ],
    };
    expect(toPrompt(card).questions[0]?.options).toEqual([{ label: "Hand back", description: "" }]);
    expect(toResolution(card, { choice: ["Hand back"] }, "2026-01-01T00:00:00.000Z")).toMatchObject(
      {
        action: "accept",
        answers: { choice: { options: ["hand-back"] } },
      },
    );
    const plain = { type: "gate", items: [{ id: "q", prompt: "Ship it?" }] };
    expect(toPrompt(plain).questions[0]?.options?.map((o) => o.label)).toEqual([
      "Approve",
      "Decline",
    ]);
  });
});

describe("tool approvals", () => {
  it("puts the command in its own field and answers with one click", async () => {
    const { toPrompt, toResolution } = await import("./mapping");
    const card = {
      type: "approval",
      title: "Bash",
      context: { command: "ls -la" },
      items: [
        {
          id: "approval",
          prompt: "Allow Bash?",
          choices: [{ id: "allow_once" }, { id: "reject_once" }],
        },
      ],
    };
    const [question] = toPrompt(card).questions;
    expect(question).toMatchObject({
      header: "Allow Bash?",
      question: "",
      detail: "ls -la",
      choiceOnly: true,
      approval: true,
    });
    expect(question?.options?.map((o) => o.label)).toEqual(["Allow once", "Deny"]);
    expect(
      toResolution(card, { approval: ["Allow once"] }, "2026-01-01T00:00:00.000Z"),
    ).toMatchObject({ action: "accept", choice: "allow_once" });
  });

  it("titles the card with the prompt, not the item's short header", async () => {
    const { toPrompt } = await import("./mapping");
    const [question] = toPrompt({
      type: "approval",
      title: "Sign in to github.com",
      context: { markdown: "Zoltbot types the password into the page." },
      items: [
        {
          id: "vault",
          header: "Vault",
          prompt: "Let Research sign in to github.com with your saved login?",
          choices: [{ id: "allow_once" }, { id: "allow_session" }, { id: "reject_once" }],
        },
      ],
    }).questions;
    expect(question).toMatchObject({
      header: "Let Research sign in to github.com with your saved login?",
      question: "Zoltbot types the password into the page.",
    });
    expect(question?.options).toHaveLength(3);
  });
});

describe("purchase approvals", () => {
  it("shows the purchase card's own buttons and answers with the offered choice", async () => {
    const { toPrompt, toResolution } = await import("./mapping");
    const card = {
      id: "browser-takeover:thread:buy-1",
      type: "approval",
      title: "Confirm purchase on shop.example.test",
      items: [
        {
          id: "choice",
          prompt: "Research wants to click “Place order”.",
          options: [
            { id: "cancel", label: "Cancel" },
            { id: "allow-click", label: "Allow click" },
          ],
          choices: [{ id: "allow_once" }, { id: "reject_once" }],
        },
      ],
    };
    expect(toPrompt(card).questions[0]?.options?.map((o) => o.label)).toEqual([
      "Cancel",
      "Allow click",
    ]);
    const at = "2026-01-01T00:00:00.000Z";
    expect(toResolution(card, { choice: ["Allow click"] }, at)).toMatchObject({
      action: "accept",
      choice: "allow_once",
    });
    expect(toResolution(card, { choice: ["Cancel"] }, at)).toMatchObject({ action: "decline" });
  });

  it("answers other approvals with options, like a tool permission, from their own choices", async () => {
    const { toPrompt, toResolution } = await import("./mapping");
    const card = {
      id: "acp-permission-1",
      type: "approval",
      items: [
        {
          id: "q",
          prompt: "Run tests?",
          options: [
            { id: "allow", label: "Allow" },
            { id: "reject", label: "Reject" },
          ],
          choices: [{ id: "allow_once" }, { id: "reject_once" }],
        },
      ],
    };
    const [question] = toPrompt(card).questions;
    expect(question?.options?.map((o) => o.label)).toEqual(["Allow once", "Deny"]);
    expect(toResolution(card, { q: ["Deny"] }, "2026-01-01T00:00:00.000Z")).toMatchObject({
      action: "decline",
    });
  });
});

describe("agentProfiles", () => {
  it("lists the agents you can chat with, by name, with a stable avatar", () => {
    const rows: Row[] = [
      { id: "codex", name: "Codex", kind: "profile" },
      { id: "claude", name: "Claude Code", kind: "profile" },
      { id: "old", name: "Old", kind: "profile", archived: true },
      { id: "hidden", name: "Hidden", kind: "profile", hidden: true },
      { id: "lead", name: "Design lead", kind: "staff" },
    ];
    const agents = agentProfiles(rows);
    expect(agents.map((agent) => agent.name)).toEqual(["Claude Code", "Codex"]);
    expect(agentProfiles(rows)).toEqual(agents);
  });
});
