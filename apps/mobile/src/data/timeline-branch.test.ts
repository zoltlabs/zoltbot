import { expect, it } from "vitest";
import { transcript } from "./timeline.js";
import type { Snapshot } from "./transport.js";

const message = (id: string, turnId: string, seq: number) => ({
  id,
  threadId: "chat",
  turnId,
  seq,
  kind: "message",
  createdAt: "2026-11-21T09:05:00.000Z",
  body: { text: id },
});

it("offers a branch only from the last reply of a turn the Mac finished", () => {
  const snapshot: Snapshot = {
    seq: 1,
    counters: {},
    entities: {
      turn: [
        { id: "done", threadId: "chat", status: "completed", nativeTurnId: "n1" },
        { id: "failed", threadId: "chat", status: "failed", nativeTurnId: "n2" },
        { id: "running", threadId: "chat", status: "running" },
      ],
      item: [
        message("a", "done", 1),
        message("b", "done", 2),
        message("c", "failed", 3),
        message("d", "running", 4),
      ],
    },
  };
  const rows = transcript(snapshot, "chat");
  expect(rows.map((row) => [row.id, row.branchTurnId])).toEqual([
    ["a", undefined],
    ["b", "done"],
    ["c", undefined],
    ["d", undefined],
  ]);
  expect(rows[0]?.at).toBe("2026-11-21T09:05:00.000Z");
});
