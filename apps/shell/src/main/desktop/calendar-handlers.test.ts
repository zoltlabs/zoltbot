import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTINE_CHANNELS } from "../../shared/routines";
import { calendarHandlers } from "./calendar-handlers";

const routine = {
  id: "routine-1",
  name: "Morning check",
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  template: {
    title: "Morning check",
    brief: "Check the build",
    acceptance: "",
    profileId: "profile",
    node: { type: "project", id: "project" },
    inputs: { knowledge: "inherit", skills: "inherit", connections: "inherit" },
  },
  permissionCeiling: "read_only",
  notify: "actionable_only",
  paused: false,
  nextRunAt: "2026-11-06T09:00:00.000Z",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

async function setup(items: unknown[]) {
  const folder = await mkdtemp(join(tmpdir(), "zolt-calendar-"));
  const opened: string[] = [];
  const handlers = calendarHandlers({
    client: { call: async () => ({ items }) },
    folder,
    open: async (path) => {
      opened.push(path);
      return "";
    },
    now: () => new Date("2026-11-06T00:00:00.000Z"),
  });
  const add = handlers[ROUTINE_CHANNELS.routinesAddToCalendar] as (input: unknown) => Promise<{
    runs: number;
  }>;
  return { add, opened };
}

describe("R6 add to calendar", () => {
  it("writes 30 days of runs and opens the file", async () => {
    const { add, opened } = await setup([routine, { id: "broken" }]);
    expect(await add({ names: true })).toEqual({ runs: 30 });
    expect(opened).toHaveLength(1);
    const ics = await readFile(opened[0] as string, "utf8");
    expect(ics).toContain("SUMMARY:Morning check");
    expect(ics).toContain("DTSTART:20261106T090000Z");
  });

  it("leaves names out when asked, and opens nothing when nothing runs", async () => {
    const hidden = await setup([routine]);
    await hidden.add({ names: false });
    const ics = await readFile(hidden.opened[0] as string, "utf8");
    expect(ics).not.toContain("Morning check");
    expect(ics).toContain("SUMMARY:Zoltbot routine");
    const paused = await setup([{ ...routine, paused: true }]);
    expect(await paused.add({ names: true })).toEqual({ runs: 0 });
    expect(paused.opened).toEqual([]);
    await expect(paused.add({})).rejects.toThrow("Invalid request.");
  });
});
