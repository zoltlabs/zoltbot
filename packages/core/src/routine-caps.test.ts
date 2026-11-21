import { describe, expect, it } from "vitest";
import type { DomainState } from "./projectors.js";
import { routineRunEstimate, setLimits } from "./routine-caps.js";

const run = (id: string, taskId: string, status = "completed") => ({
  id,
  routineId: "r",
  taskId,
  status,
  scheduledAt: `2026-11-0${id}T00:00:00.000Z`,
});
const usage = (taskId: string, costUsd: number) => ({
  id: `u-${taskId}-${costUsd}`,
  taskId,
  costUsd,
});

describe("A9 routine cost", () => {
  it("estimates a run from the last 5 finished runs with spend", () => {
    const state = {
      routineOccurrence: [
        run("1", "t1"),
        run("2", "t2"),
        run("3", "t3"),
        run("4", "t4"),
        run("5", "t5"),
        run("6", "t6"),
        run("7", "t7", "expired"),
        run("8", "t8"),
      ],
      usage: [
        usage("t1", 9),
        usage("t2", 0.2),
        usage("t3", 0.4),
        usage("t4", 0.6),
        usage("t5", 0.3),
        usage("t6", 0.5),
        usage("t7", 9),
      ],
    } as unknown as DomainState;
    // t8 has no spend recorded and t7 expired; t1 is older than the last five.
    expect(routineRunEstimate(state, "r")).toBeCloseTo(0.4);
    expect(routineRunEstimate({} as DomainState, "r")).toBeUndefined();
  });

  it("sets caps only for people who confirm, on known fields", () => {
    const state = { routine: [{ id: "r" }], settings: [] } as unknown as DomainState;
    const context = {
      commandId: "c",
      at: "2026-11-01T00:00:00.000Z",
      actor: { kind: "human" as const, id: "o" },
    };
    const input = { scopeType: "routine", scopeId: "r", limits: { usdPerRun: 5 }, confirmed: true };
    expect(setLimits(state, input, context).result).toEqual({ ok: true });
    expect(() => setLimits(state, { ...input, confirmed: false }, context)).toThrow("confirmation");
    expect(() =>
      setLimits(state, input, { ...context, actor: { kind: "agent", id: "a" } as never }),
    ).toThrow("confirmation");
    expect(() => setLimits(state, { ...input, limits: { usdPerWeek: 5 } }, context)).toThrow(
      "invalid_limit",
    );
    expect(() => setLimits(state, { ...input, limits: { usdPerRun: -1 } }, context)).toThrow(
      "invalid_limit",
    );
  });
});
