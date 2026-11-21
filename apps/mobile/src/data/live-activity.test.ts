import { describe, expect, it } from "vitest";
import { activityView, planActivity } from "./live-activity.js";
import type { Snapshot } from "./transport.js";

const snapshot = (entities: Snapshot["entities"]): Snapshot => ({ seq: 1, entities, counters: {} });
const busy = { working: 2, needsYou: 1 };

describe("Live Activity plan", () => {
  it("starts when work begins, updates on change, ends when all is quiet", () => {
    expect(planActivity(false, undefined, { working: 0, needsYou: 0 }, true)).toEqual({
      kind: "none",
    });
    expect(planActivity(false, undefined, busy, true)).toEqual({ kind: "start", view: busy });
    expect(planActivity(true, busy, busy, true)).toEqual({ kind: "none" });
    const next = { working: 1, needsYou: 1 };
    expect(planActivity(true, busy, next, true)).toEqual({ kind: "update", view: next });
    expect(planActivity(true, next, { working: 0, needsYou: 0 }, true)).toEqual({ kind: "end" });
  });

  it("updates when the top request changes even if the counts don't", () => {
    const a = { ...busy, top: { interactionId: "a", threadId: "t", title: "Deploy" } };
    const b = { ...busy, top: { interactionId: "b", threadId: "t", title: "Merge" } };
    expect(planActivity(true, a, b, true).kind).toBe("update");
  });

  it("ends, and never starts, while turned off", () => {
    expect(planActivity(true, busy, busy, false)).toEqual({ kind: "end" });
    expect(planActivity(false, undefined, busy, false)).toEqual({ kind: "none" });
  });

  it("counts like the Mac: later, muted and routine reviews are left out", () => {
    const view = activityView(
      snapshot({
        task: [
          { id: "r1", state: "review", routineOccurrenceId: "o1" },
          { id: "r2", state: "review" },
        ],
        interaction: [
          { id: "a", state: "pending", type: "question", threadId: "quiet", createdAt: "1" },
          { id: "b", state: "pending", type: "question", threadId: "h", createdAt: "2" },
          { id: "c", state: "pending", type: "question", threadId: "h", createdAt: "3" },
        ],
        settings: [
          { key: "chat.muted.quiet", value: true },
          { key: "chief.queue", value: { items: { c: { rank: "later", why: "" } } } },
        ],
      }),
    );
    expect(view).toMatchObject({ working: 0, needsYou: 2, top: { interactionId: "b" } });
  });

  it("reads counts and the top request from the snapshot", () => {
    const view = activityView(
      snapshot({
        task: [
          { id: "t1", state: "running" },
          { id: "t2", state: "done" },
        ],
        interaction: [
          {
            id: "i1",
            state: "pending",
            type: "approval",
            threadId: "h1",
            title: "Run   the\nmigration",
            version: 1,
            items: [],
          },
        ],
      }),
    );
    expect(view).toEqual({
      working: 1,
      needsYou: 1,
      top: { interactionId: "i1", threadId: "h1", title: "Run the migration" },
    });
    expect(activityView(snapshot({}))).toEqual({ working: 0, needsYou: 0 });
  });
});
