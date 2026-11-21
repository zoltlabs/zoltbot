import type { Routine } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import {
  isConflict,
  readClockText,
  readSchedule,
  routineStatus,
  scheduleLabel,
  writeError,
  writeSchedule,
} from "./manage";

describe("routine schedules", () => {
  it("reads and writes the shapes zoltd runs", () => {
    for (const cron of ["0 9 * * *", "30 21 * * 1,2,3,4,5", "0 8 * * 1", "@every 90m"])
      expect(writeSchedule(readSchedule(cron))).toBe(cron);
    expect(readSchedule("30 21 * * 5,1,2,3,4")).toMatchObject({ days: "weekdays" });
    expect(readSchedule("0 9 1 * *")).toEqual({ kind: "other", cron: "0 9 1 * *" });
  });

  it("labels schedules in words", () => {
    expect(scheduleLabel("0 9 * * *")).toBe("Daily at 9:00");
    expect(scheduleLabel("5 18 * * 1,2,3,4,5")).toBe("Weekdays at 18:05");
    expect(scheduleLabel("0 8 * * 1,3")).toBe("Mon, Wed at 8:00");
    expect(scheduleLabel("@every 60m")).toBe("Every hour");
    expect(scheduleLabel("@every 120m")).toBe("Every 2 hours");
    expect(scheduleLabel("@every 15m")).toBe("Every 15 min");
  });

  it("reads typed times", () => {
    expect(readClockText(" 9:05 ")).toEqual({ hour: 9, minute: 5 });
    expect(readClockText("24:00")).toBeUndefined();
    expect(readClockText("9")).toBeUndefined();
  });
});

describe("write errors", () => {
  it("treats every stale-write code as a conflict", () => {
    for (const code of [
      "stale_revision",
      "knowledge_revision_conflict",
      "setting_conflict",
      "connection_disconnect_changed",
    ]) {
      expect(isConflict(new Error(code)), code).toBe(true);
      expect(writeError(new Error(code))).toBe("Changed on your Mac.");
    }
    expect(isConflict(new Error("connection_health_failed"))).toBe(false);
    expect(writeError(new Error("Your Mac is offline."))).toBe("Not sent. Your Mac is offline.");
    expect(writeError(new Error("boom"))).toBe("Not saved. Try again.");
  });
});

it("R1: labels a one-time routine and a finished one", () => {
  const routine = {
    paused: false,
    nextRunAt: "2026-11-06T14:00:00.000Z",
    schedule: { cron: "@once", timezone: "UTC", at: "2026-11-06T14:00:00.000Z" },
  } as Routine;
  expect(scheduleLabel("@once")).toBe("Once");
  expect(routineStatus(routine)).toMatch(/^Once, .*Nov/);
  expect(routineStatus({ ...routine, doneAt: "2026-11-06T14:00:10.000Z" })).toBe("Done");
});
