import { describe, expect, it } from "vitest";
import { inQueueOrder, moved, queuedIds } from "./queue-order.js";
import type { Snapshot } from "./transport.js";
import type { TranscriptRow } from "./view.js";

const item = (id: string, seq: number, queueState: string, queuePosition?: number) => ({
  id,
  threadId: "t",
  kind: "user",
  seq,
  body: { queueState, ...(queuePosition === undefined ? {} : { queuePosition }) },
});

describe("queue order", () => {
  it("lists queued messages by the owner's order, then arrival", () => {
    const snapshot = {
      entities: {
        item: [
          item("sent", 1, "sent"),
          item("a", 2, "queued", 4),
          item("b", 3, "queued", 2),
          item("c", 4, "queued"),
        ],
      },
    } as unknown as Snapshot;
    expect(queuedIds(snapshot, "t")).toEqual(["b", "a", "c"]);
  });

  it("puts queued rows in queue order and leaves the others where they are", () => {
    const row = (id: string, queued: boolean) =>
      ({ id, kind: "user", text: id, ...(queued ? { queued: true } : {}) }) as TranscriptRow;
    const rows = [row("x", false), row("a", true), row("y", false), row("b", true)];
    expect(inQueueOrder(rows, ["b", "a"]).map((r) => r.id)).toEqual(["x", "b", "y", "a"]);
    // An order that doesn't match (a snapshot in between) leaves the rows alone.
    expect(inQueueOrder(rows, ["b"]).map((r) => r.id)).toEqual(["x", "a", "y", "b"]);
  });

  it("moves an id and returns null when nothing would change", () => {
    expect(moved(["a", "b", "c"], "c", 1)).toEqual(["a", "c", "b"]);
    expect(moved(["a", "b"], "a", -1)).toBeNull();
    expect(moved(["a", "b"], "b", 1)).toBeNull();
  });
});
