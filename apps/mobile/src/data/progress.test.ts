import { chatProgressKey } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { conversation } from "./conversation";
import { withProgress } from "./progress";
import type { TranscriptRow } from "./timeline";

const snapshot = (notes: unknown[]) => ({
  seq: 1,
  counters: {},
  entities: {
    item: [
      { id: "asked", threadId: "chat", kind: "user", createdAt: "10:00" },
      { id: "tool", threadId: "chat", kind: "tool", turnId: "t", createdAt: "10:01" },
      { id: "answer", threadId: "chat", kind: "message", turnId: "t", createdAt: "10:05" },
      { id: "later", threadId: "chat", kind: "message", turnId: "t2", createdAt: "11:00" },
    ],
    settings: [{ key: chatProgressKey("chat"), value: notes }],
  },
});
const row = (id: string, kind = "message") =>
  ({ id, kind, text: id, streaming: false }) as TranscriptRow;
// An artifact row has no item of its own, so it has no time.
const rows = [
  row("asked", "user"),
  row("tool", "tool"),
  row("answer"),
  row("later"),
  row("art", "artifact"),
];

it("places each note inside its own turn, at the time it was posted", () => {
  const notes = [
    { id: "n1", turnId: "t", text: "Plan first", at: "10:00:30" },
    { id: "n2", turnId: "t", text: "Tests pass", at: "10:03" },
  ];
  const merged = withProgress(snapshot(notes), "chat", rows);
  expect(merged.map((r) => r.id)).toEqual([
    "asked",
    "progress:n1",
    "tool",
    "progress:n2",
    "answer",
    "later",
    "art",
  ]);
  expect(merged[3]).toMatchObject({
    text: "Tests pass",
    turnId: "t",
    progress: { threadId: "chat" },
  });
  expect(withProgress(snapshot(notes), "other", rows)).toBe(rows);
});

it("puts a running turn's first note at the end, and keeps it in that turn's group", () => {
  const merged = withProgress(
    snapshot([{ id: "n3", turnId: "t3", text: "Starting", at: "12:00" }]),
    "chat",
    rows,
  );
  expect(merged.at(-1)?.id).toBe("progress:n3");
  const notes = [{ id: "n2", turnId: "t", text: "Tests pass", at: "10:03" }];
  const entries = conversation(withProgress(snapshot(notes), "chat", rows), snapshot(notes), "t");
  const turn = entries.find((entry) => entry.kind === "assistant" && entry.id === "t");
  expect(turn?.kind === "assistant" && turn.rows.map((r) => r.id)).toEqual([
    "tool",
    "progress:n2",
    "answer",
  ]);
  expect(turn?.kind === "assistant" && turn.active).toBe(true);
});
