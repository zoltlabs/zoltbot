import { type Profile, parse, RoutineSchema } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { nextRoutineRun, routineGrace } from "./routine-time.js";
import {
  clampRoutinePermission,
  routineOutcome,
  routineProfile,
  routineShouldNotify,
} from "./routines.js";

it("computes daily and weekly local runs and epoch-aligned interval runs", () => {
  expect(
    nextRoutineRun({ cron: "0 9 * * *", timezone: "Asia/Kolkata" }, "2026-11-04T00:00:00Z"),
  ).toBe("2026-11-04T03:30:00.000Z");
  expect(
    nextRoutineRun({ cron: "0 9 * * 1", timezone: "America/New_York" }, "2026-11-04T00:00:00Z"),
  ).toBe("2026-11-09T14:00:00.000Z");
  expect(nextRoutineRun({ cron: "@every 60m", timezone: "UTC" }, "2026-11-04T00:15:00Z")).toBe(
    "2026-11-04T01:00:00.000Z",
  );
  expect(() =>
    nextRoutineRun({ cron: "99 9 * * *", timezone: "UTC" }, "2026-11-04T00:00:00Z"),
  ).toThrow("invalid_routine_schedule");
  expect(() =>
    nextRoutineRun({ cron: "0 9 * * *", timezone: "invalid" }, "2026-11-04T00:00:00Z"),
  ).toThrow();
  expect(routineGrace({ cron: "@every 60m", timezone: "UTC" }, "2026-11-04T01:00:00Z")).toBe(
    30 * 60_000,
  );
  expect(routineGrace({ cron: "0 9 * * *", timezone: "UTC" }, "2026-11-04T09:00:00Z")).toBe(
    3 * 60 * 60_000,
  );
});
it("runs a nonexistent spring time at the next valid minute and a folded autumn time only once", () => {
  const spring = { cron: "30 2 * * *", timezone: "America/New_York" };
  expect(nextRoutineRun(spring, "2026-03-08T00:00:00Z")).toBe("2026-03-08T07:00:00.000Z");
  const fall = { cron: "30 1 * * *", timezone: "America/New_York" };
  expect(nextRoutineRun(fall, "2026-11-01T00:00:00Z")).toBe("2026-11-01T05:30:00.000Z");
  expect(nextRoutineRun(fall, "2026-11-01T05:30:00Z")).toBe("2026-11-02T06:30:00.000Z");
  expect(nextRoutineRun(fall, "2026-11-01T06:15:00Z")).toBe("2026-11-02T06:30:00.000Z");
});
it("handles the half-hour DST gap on Lord Howe", () => {
  expect(
    nextRoutineRun({ cron: "15 2 * * *", timezone: "Australia/Lord_Howe" }, "2026-10-03T00:00:00Z"),
  ).toBe("2026-10-03T15:30:00.000Z");
});
it("validates the final outcome marker and defaults missing, duplicated or invalid outcomes to actionable", () => {
  for (const outcome of ["nothing", "actionable", "needs_you"] as const) {
    expect(routineOutcome(`Result\n[ZOLTBOT_OUTCOME:${outcome}]`)).toBe(outcome);
    expect(routineShouldNotify("always", outcome)).toBe(true);
    expect(routineShouldNotify("actionable_only", outcome)).toBe(outcome !== "nothing");
  }
  for (const text of [
    "Nothing to do",
    "[ZOLTBOT_OUTCOME:unknown]",
    "[ZOLTBOT_OUTCOME:nothing] trailing",
    "[ZOLTBOT_OUTCOME:actionable]\n[ZOLTBOT_OUTCOME:nothing]",
  ])
    expect(routineOutcome(text)).toBe("actionable");
});
it("clamps permissions and keeps the captured ceiling after a saved profile widens", () => {
  expect(clampRoutinePermission("full_access", "read_only")).toBe("read_only");
  expect(clampRoutinePermission("read_only", "full_access")).toBe("read_only");
  const profile = { id: "p", permissionProfile: "full_access" } as Profile;
  expect(
    routineProfile({ task: [{ id: "t", permissionCeiling: "read_only" }] }, "t", profile)
      .permissionProfile,
  ).toBe("read_only");
});
it("rejects the former workflow and continuing-session routine contract", () => {
  expect(() =>
    parse(RoutineSchema, { id: "old", target: { kind: "prompt", chatMode: "continue" } }),
  ).toThrow();
});
