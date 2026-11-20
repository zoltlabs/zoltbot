import { expect, it } from "vitest";
import { withAsides } from "./asides";
import type { TranscriptRow } from "./timeline";
import type { Row, Snapshot } from "./transport";

const at = (minute: number) => `2026-11-20T10:0${minute}:00.000Z`;
const snapshot = (entities: Record<string, Row[]>) => ({ entities }) as unknown as Snapshot;
const row = (id: string): TranscriptRow => ({ id, kind: "user", text: id, streaming: false });

it("shows an aside after the row it followed, with a placeholder until it answers", () => {
  const state = snapshot({
    thread: [{ id: "a1", kind: "aside", createdAt: at(2), fork: { sourceThreadId: "chat" } }],
    item: [
      { id: "m1", threadId: "chat", createdAt: at(1) },
      { id: "m3", threadId: "chat", createdAt: at(3) },
      {
        id: "q",
        threadId: "a1",
        seq: 1,
        kind: "user",
        body: { input: [{ type: "text", text: "Which file?" }] },
      },
    ],
    turn: [{ id: "t", threadId: "a1", status: "running" }],
  });
  expect(
    withAsides(state, "chat", [row("m1"), row("m3")]).map((r) => [r.id, r.aside?.question]),
  ).toEqual([
    ["m1", undefined],
    ["q", true],
    ["a1:pending", false],
    ["m3", undefined],
  ]);
  expect(withAsides(snapshot({}), "chat", [row("m1")])).toEqual([row("m1")]);
});
