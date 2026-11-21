import { describe, expect, it } from "vitest";
import { icsFold, icsText, routineCalendar } from "./routine-calendar.js";

const routine = {
  id: "r1",
  name: "Check builds; nightly, all",
  paused: false,
  nextRunAt: "2026-11-06T09:00:00.000Z",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
};

describe("R6 routine calendar", () => {
  it("lists each run with its name and time", () => {
    const ics = routineCalendar([routine, { ...routine, id: "r2", paused: true }], {
      from: "2026-11-06T00:00:00.000Z",
      until: "2026-11-08T00:00:00.000Z",
      names: true,
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("DTSTART:20261106T090000Z");
    expect(ics).toContain("DTSTART:20261107T090000Z");
    expect(ics).toContain("SUMMARY:Check builds\\; nightly\\, all");
    expect(ics).toContain("UID:r1-20261106T090000Z@zoltbot");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("can leave names out", () => {
    const ics = routineCalendar([routine], {
      from: "2026-11-06T00:00:00.000Z",
      until: "2026-11-07T00:00:00.000Z",
      names: false,
    });
    expect(ics).toContain("SUMMARY:Zoltbot routine");
    expect(ics).not.toContain("Check builds");
  });

  it("escapes and folds text", () => {
    expect(icsText("a\\b\nc")).toBe("a\\\\b\\nc");
    expect(icsText("Build; ship, rest")).toBe("Build\\; ship\\, rest");
    expect(icsText("a\u0000b\u2028c\td")).toBe("abcd");
    const folded = icsFold(`SUMMARY:${"é".repeat(60)}`);
    for (const line of folded.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(60)}`);
  });
});
