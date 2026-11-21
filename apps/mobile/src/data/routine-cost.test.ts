import { describe, expect, it } from "vitest";
import { capWidens, costPerRunText, readRoutineCost } from "./routine-cost.js";

describe("A9 routine cost", () => {
  it("says the estimate only when there is history", () => {
    expect(costPerRunText(0.4)).toBe("About $0.40 a run");
    expect(costPerRunText(12.3)).toBe("About $12.30 a run");
    expect(costPerRunText(0.001)).toBe("Under $0.01 a run");
    expect(costPerRunText(undefined)).toBeUndefined();
  });
  it("reads limits.get and asks before a cap goes up", () => {
    expect(readRoutineCost({ usdPerRun: 5, estimateUsdPerRun: 0.4 })).toEqual({
      cap: 5,
      estimate: 0.4,
    });
    expect(readRoutineCost({})).toEqual({});
    expect(capWidens(5, 20)).toBe(true);
    expect(capWidens(5, undefined)).toBe(true);
    expect(capWidens(20, 5)).toBe(false);
    expect(capWidens(undefined, 5)).toBe(false);
  });
});
