import { describe, expect, it } from "vitest";
import {
  draftOf,
  fromWallClock,
  scheduleOf,
  scheduleText,
  statusText,
  triggerText,
} from "./routine-format";

describe("routine schedules in the editor", () => {
  it("round-trips the shapes the editor shows", () => {
    for (const cron of ["0 9 * * *", "30 7 * * 1,2,3,4,5", "@every 90m"])
      expect(scheduleOf(draftOf({ cron, timezone: "UTC" }))?.cron).toBe(cron);
    expect(draftOf({ cron: "0 9 * * 1", timezone: "UTC" })).toEqual({
      kind: "custom",
      cron: "0 9 * * 1",
      timezone: "UTC",
    });
  });

  it("turns a wall-clock date and time into an instant in the routine's timezone", () => {
    expect(fromWallClock("2026-11-06", "09:00", "America/New_York")).toBe(
      "2026-11-06T14:00:00.000Z",
    );
    // 2:30 doesn't exist on the morning clocks go forward; it rolls on to 3:00.
    expect(fromWallClock("2026-03-08", "02:30", "America/New_York")).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    const once = { cron: "@once", at: "2026-11-06T14:00:00.000Z", timezone: "America/New_York" };
    expect(draftOf(once)).toMatchObject({ kind: "once", date: "2026-11-06", time: "09:00" });
    expect(scheduleOf(draftOf(once))).toEqual(once);
    expect(scheduleOf({ kind: "once", date: "", time: "09:00", timezone: "UTC" })).toBeUndefined();
  });

  it("says when a routine runs in words", () => {
    expect(scheduleText({ cron: "0 9 * * *", timezone: "UTC" })).toBe("Daily at 9:00 AM");
    expect(scheduleText({ cron: "5 17 * * 1,2,3,4,5", timezone: "UTC" })).toBe(
      "Weekdays at 5:05 PM",
    );
    expect(scheduleText({ cron: "@every 60m", timezone: "UTC" })).toBe("Every hour");
    expect(scheduleText({ cron: "@every 120m", timezone: "UTC" })).toBe("Every 2 hours");
    expect(scheduleText({ cron: "@every 15m", timezone: "UTC" })).toBe("Every 15 minutes");
    expect(
      scheduleText({ cron: "@once", at: "2026-11-06T14:00:00.000Z", timezone: "UTC" }, "en-US"),
    ).toBe("Once, Fri, Nov 6, 2:00 PM");
    const item = {
      id: "r",
      name: "Check",
      agent: "Agent",
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      paused: false,
      nextRunAt: "2026-11-06T09:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    expect(statusText(item, "en-US")).toBe("Next Fri, Nov 6, 9:00 AM");
    expect(statusText({ ...item, paused: true })).toBe("Paused");
    expect(statusText({ ...item, doneAt: item.nextRunAt })).toBe("Done");
  });

  it("names a webhook routine by its address name", () => {
    expect(triggerText({ kind: "webhook.received", resource: "webhook/deploys" })).toBe(
      "When the deploys web address is called",
    );
  });
});
