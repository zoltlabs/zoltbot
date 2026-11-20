// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Row, Snapshot } from "./daemon-client";
import { latestPlan, toMessages } from "./mapping";

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
