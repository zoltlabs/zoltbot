import { describe, expect, it } from "vitest";
import { activityLabel, assistantSegments, conversation } from "./conversation.js";
import { inline } from "./markdown.js";
import { toolTitle, transcript } from "./timeline.js";
import type { Snapshot } from "./transport.js";

function fixture(): Snapshot {
  return {
    seq: 1,
    counters: {},
    entities: {
      item: [
        {
          id: "u",
          kind: "user",
          turnId: "t",
          threadId: "chat",
          seq: 1,
          body: { input: [{ type: "text", text: "Help" }] },
        },
        {
          id: "m",
          kind: "message",
          turnId: "t",
          threadId: "chat",
          seq: 2,
          body: { text: "Checking." },
        },
        {
          id: "tool",
          kind: "tool",
          turnId: "t",
          threadId: "chat",
          seq: 3,
          body: { name: "Search", status: "ok" },
        },
        {
          id: "final",
          kind: "message",
          turnId: "t",
          threadId: "chat",
          seq: 4,
          body: { text: "Found it." },
        },
      ],
    },
  };
}

describe("mobile assistant turns", () => {
  it("keeps intermediate text, tool activity and the answer in one ordered turn", () => {
    const snapshot = fixture();
    const entries = conversation(transcript(snapshot, "chat"), snapshot, "t");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.kind).toBe("row");
    expect(entries[1]).toMatchObject({
      kind: "assistant",
      active: true,
      rows: [{ id: "m" }, { id: "tool" }, { id: "final" }],
    });
  });
  it("shows progress before the first provider event and removes it on completion", () => {
    const snapshot: Snapshot = { seq: 0, entities: {}, counters: {} };
    expect(conversation([], snapshot, "new")).toEqual([
      { id: "new", kind: "assistant", rows: [], active: true },
    ]);
    expect(conversation([], snapshot)).toEqual([]);
  });
  it("never merges across a user message and only shows progress on the last fragment", () => {
    const snapshot = fixture();
    snapshot.entities.item?.splice(3, 0, {
      id: "steer",
      kind: "user",
      turnId: "t",
      threadId: "chat",
      seq: 3.5,
      body: { input: [{ type: "text", text: "Also check this" }] },
    });
    const entries = conversation(transcript(snapshot, "chat"), snapshot, "t");
    expect(entries.map((entry) => entry.kind)).toEqual(["row", "assistant", "row", "assistant"]);
    expect(entries.filter((entry) => entry.kind === "assistant" && entry.active)).toHaveLength(1);
  });
  it("keeps failures visible in collapsed summaries", () => {
    expect(
      activityLabel([
        { id: "x", kind: "tool", text: "Search", streaming: false, status: "failed" },
      ]),
    ).toBe("1 tool failed");
    expect(
      activityLabel(
        [{ id: "x", kind: "tool", text: "Search", streaming: false, status: "running" }],
        true,
      ),
    ).toBe("Working…");
  });
});

it("replaces generic provider tool labels with the available action", () => {
  expect(
    toolTitle({
      body: {
        name: "Interaction",
        title: "Interaction",
        kind: "execute",
        status: "running",
        input: { command: "pnpm test" },
      },
    }),
  ).toBe("Running pnpm test");
  expect(toolTitle({ body: { name: "interaction" } })).toBe("Tool activity");
});

it("keeps answer links actionable and unsafe schemes as plain text", () => {
  expect(inline("[Source](https://example.com)")).toEqual([
    { text: "Source", href: "https://example.com" },
  ]);
  expect(inline("[Unsafe](javascript:alert)")).toEqual([{ text: "[Unsafe](javascript:alert)" }]);
});

it("keeps unresolved failures outside disclosures and folds only a matching recovered retry", () => {
  const snapshot = fixture();
  snapshot.entities.item = [
    {
      id: "bad",
      kind: "tool",
      turnId: "t",
      threadId: "chat",
      seq: 1,
      body: { kind: "execute", title: "test", status: "error" },
    },
    {
      id: "ok",
      kind: "tool",
      turnId: "t",
      threadId: "chat",
      seq: 2,
      body: { kind: "execute", title: "test", status: "ok" },
    },
    {
      id: "unfixed",
      kind: "tool",
      turnId: "t",
      threadId: "chat",
      seq: 3,
      body: { kind: "read", title: "missing", status: "error" },
    },
  ];
  const entry = conversation(transcript(snapshot, "chat"), snapshot)[0];
  if (entry?.kind !== "assistant") throw new Error("Expected assistant turn");
  expect(
    assistantSegments(entry.rows).map((segment) => ({
      activity: segment.activity,
      ids: segment.rows.map((row) => row.id),
    })),
  ).toEqual([
    { activity: true, ids: ["bad", "ok"] },
    { activity: false, ids: ["unfixed"] },
  ]);
});
