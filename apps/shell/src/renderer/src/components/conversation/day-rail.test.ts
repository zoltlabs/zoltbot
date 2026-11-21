import { describe, expect, it } from "vitest";
import { currentDay, dayLabel, dayStarts, showsRail, spanDays } from "./day-rail";

/** An ISO time for a local date and hour, so the tests hold in any time zone. */
const at = (month: number, day: number, hour = 12, year = 2026) =>
  new Date(year, month - 1, day, hour).toISOString();

describe("day starts", () => {
  it("finds the first item of each local day, oldest first", () => {
    const days = dayStarts([
      { id: "a", createdAt: at(11, 17, 9) },
      { id: "b", createdAt: at(11, 17, 23) },
      { id: "c", createdAt: at(11, 18, 0) },
      { id: "d", createdAt: at(11, 20, 8) },
      { id: "e", createdAt: at(11, 20, 9) },
    ]);
    expect(days.map((day) => [day.day, day.firstId])).toEqual([
      ["2026-11-17", "a"],
      ["2026-11-18", "c"],
      ["2026-11-20", "d"],
    ]);
  });

  it("skips items without a valid time", () => {
    const days = dayStarts([
      { id: "a" },
      { id: "b", createdAt: "not a time" },
      { id: "c", createdAt: at(11, 18) },
    ]);
    expect(days.map((day) => day.firstId)).toEqual(["c"]);
  });

  it("keeps a day's first item when a later item is out of order", () => {
    const days = dayStarts([
      { id: "a", createdAt: at(11, 19) },
      { id: "b", createdAt: at(11, 17) },
      { id: "c", createdAt: at(11, 19, 20) },
    ]);
    expect(days.map((day) => day.firstId)).toEqual(["b", "a"]);
  });
});

describe("when the rail shows", () => {
  it("shows for a chat over more than two calendar days", () => {
    const two = dayStarts([
      { id: "a", createdAt: at(11, 17, 23) },
      { id: "b", createdAt: at(11, 18, 1) },
    ]);
    expect(spanDays(two)).toBe(2);
    expect(showsRail(two)).toBe(false);
    const spread = dayStarts([
      { id: "a", createdAt: at(11, 17) },
      { id: "b", createdAt: at(11, 19) },
    ]);
    expect(spanDays(spread)).toBe(3);
    expect(showsRail(spread)).toBe(true);
    expect(showsRail([])).toBe(false);
  });

  it("counts days across a daylight-saving change", () => {
    const days = dayStarts([
      { id: "a", createdAt: at(3, 7, 12) },
      { id: "b", createdAt: at(3, 10, 12) },
    ]);
    expect(spanDays(days)).toBe(4);
  });
});

describe("labels and position", () => {
  it("names the day, with the year only when it isn't this year", () => {
    const now = new Date(2026, 10, 21);
    expect(dayLabel(new Date(2026, 10, 18), now, "en-US")).toBe("Wednesday, November 18");
    expect(dayLabel(new Date(2025, 11, 31), now, "en-US")).toBe("Wednesday, December 31, 2025");
  });

  it("picks the last day that starts above the line", () => {
    expect(currentDay([0, 400, 900], 0)).toBe(0);
    expect(currentDay([0, 400, 900], 450)).toBe(1);
    expect(currentDay([0, 400, 900], 5000)).toBe(2);
    expect(currentDay([0, Number.POSITIVE_INFINITY], 100)).toBe(0);
  });
});
