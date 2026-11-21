import { describe, expect, it } from "vitest";
import { nextRoutineRun, upcomingRuns } from "./routine-time.js";

const MINUTE = 60_000;

/** The old minute-by-minute search, kept as the reference the faster one must match. */
function reference(cron: string, timezone: string, after: string): string {
  const [minute, hour, , , days] = cron.split(" ");
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const local = (at: number) => {
    const p = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
    return {
      date: `${p.year}-${p.month}-${p.day}`,
      minute: Number(p.hour) * 60 + Number(p.minute),
    };
  };
  const now = Date.parse(after);
  const today = local(now).date;
  const wanted = Number(hour) * 60 + Number(minute);
  for (let offset = 0; offset < 9; offset++) {
    const day = Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000;
    if (days !== "*" && !days?.split(",").map(Number).includes(new Date(day).getUTCDay())) continue;
    const date = new Date(day).toISOString().slice(0, 10);
    for (let at = day - 15 * 60 * MINUTE; at < day + 39 * 60 * MINUTE; at += MINUTE) {
      const wall = local(at);
      if (wall.date === date && wall.minute >= wanted) {
        if (at > now) return new Date(at).toISOString();
        break;
      }
    }
  }
  throw new Error("none");
}

describe("routine schedule maths", () => {
  it("matches the minute-by-minute search across clock changes", () => {
    const zones = [
      "America/Los_Angeles",
      "Europe/London",
      "Australia/Lord_Howe",
      "Pacific/Kiritimati",
      "Asia/Kolkata",
    ];
    const crons = ["30 1 * * *", "0 2 * * *", "59 23 * * *", "30 2 * * 0", "0 0 * * 1,2,3,4,5"];
    // Around the spring and autumn changes in both hemispheres.
    const afters = [
      "2026-03-07T12:00:00.000Z",
      "2026-03-28T12:00:00.000Z",
      "2026-04-04T12:00:00.000Z",
      "2026-10-03T12:00:00.000Z",
      "2026-10-24T12:00:00.000Z",
      "2026-10-31T12:00:00.000Z",
    ];
    for (const timezone of zones)
      for (const cron of crons)
        for (const start of afters) {
          let after = start;
          for (let step = 0; step < 4; step++) {
            const expected = reference(cron, timezone, after);
            expect(nextRoutineRun({ cron, timezone }, after), `${cron} ${timezone} ${after}`).toBe(
              expected,
            );
            after = expected;
          }
        }
  });

  it("lists 60 days of runs for ten daily routines quickly", () => {
    const from = "2026-11-06T00:00:00.000Z";
    const routines = Array.from({ length: 10 }, (_, index) => ({
      id: `r${index}`,
      paused: false,
      nextRunAt: from,
      schedule: { cron: "30 23 * * *", timezone: "America/Los_Angeles" },
    }));
    const started = performance.now();
    expect(upcomingRuns(routines, from, "2027-01-05T00:00:00.000Z")).toHaveLength(600);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
