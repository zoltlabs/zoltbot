import { describe, expect, it } from "vitest";
import { dayKey, monthWeeks } from "./ScheduleView";

describe("R3 calendar", () => {
  it("lays a month out in full weeks, Sunday first", () => {
    const weeks = monthWeeks(new Date(2026, 10, 1));
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]?.[0]?.getDate()).toBe(1); // Nov 1 2026 is a Sunday.
    expect(weeks.flat().filter(Boolean)).toHaveLength(30);
  });

  it("keys days by the local calendar", () => {
    expect(dayKey(new Date(2026, 10, 6, 23, 30))).toBe("2026-11-06");
  });
});
