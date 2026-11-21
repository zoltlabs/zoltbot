import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentsWorking,
  KEEP_AWAKE_LEAD_MS,
  keepAwakeController,
  nextCheckAt,
  nextRoutineAt,
  shouldKeepAwake,
} from "./keep-awake";

const NOW = Date.parse("2026-11-06T09:00:00.000Z");
const minutes = (count: number) => count * 60_000;

describe("R4 keep awake", () => {
  afterEach(() => vi.useRealTimers());

  it("decides from the mode, running work and the next routine", () => {
    const due = NOW + minutes(5);
    expect(shouldKeepAwake("never", { working: true, nextRoutineAt: due, now: NOW })).toBe(false);
    expect(shouldKeepAwake("working", { working: true, nextRoutineAt: undefined, now: NOW })).toBe(
      true,
    );
    expect(shouldKeepAwake("working", { working: false, nextRoutineAt: due, now: NOW })).toBe(
      false,
    );
    expect(
      shouldKeepAwake("working-or-due", { working: false, nextRoutineAt: due, now: NOW }),
    ).toBe(true);
    const later = NOW + KEEP_AWAKE_LEAD_MS + 1;
    expect(
      shouldKeepAwake("working-or-due", { working: false, nextRoutineAt: later, now: NOW }),
    ).toBe(false);
    // A run long missed doesn't hold the Mac awake forever.
    const missed = NOW - minutes(30);
    expect(
      shouldKeepAwake("working-or-due", { working: false, nextRoutineAt: missed, now: NOW }),
    ).toBe(false);
  });

  it("reads the soonest routine and running work from daemon rows", () => {
    expect(
      nextRoutineAt([
        { nextRunAt: "2026-11-06T12:00:00.000Z" },
        { nextRunAt: "2026-11-06T10:00:00.000Z", paused: true },
        { nextRunAt: "2026-11-06T10:00:00.000Z", doneAt: "2026-11-06T08:00:00.000Z" },
        { nextRunAt: "2026-11-06T10:00:00.000Z", event: { kind: "github.ci_failed" } },
        { nextRunAt: "not a date" },
      ]),
    ).toBe(Date.parse("2026-11-06T12:00:00.000Z"));
    expect(nextRoutineAt([])).toBeUndefined();
    expect(agentsWorking([{ status: "completed" }], [{ state: "running" }])).toBe(true);
    expect(agentsWorking([{ status: "running" }], [])).toBe(true);
    expect(agentsWorking([{ status: "interrupted" }], [{ state: "review" }])).toBe(false);
  });

  it("knows when to look again", () => {
    const due = NOW + minutes(60);
    expect(nextCheckAt("working-or-due", due, NOW)).toBe(due - KEEP_AWAKE_LEAD_MS);
    expect(nextCheckAt("working-or-due", NOW + minutes(5), NOW)).toBe(NOW + minutes(10) + 1);
    expect(nextCheckAt("working", due, NOW)).toBeUndefined();
  });

  it("starts one blocker and stops it when nothing needs it", async () => {
    vi.useFakeTimers({ now: NOW });
    const blocker = { start: vi.fn(() => 7), stop: vi.fn() };
    let mode: "never" | "working" | "working-or-due" = "working-or-due";
    let online = true;
    const rows = {
      turn: [] as Record<string, unknown>[],
      task: [],
      routine: [{ nextRunAt: new Date(NOW + minutes(30)).toISOString() }],
    };
    const controller = keepAwakeController({
      blocker,
      mode: () => mode,
      rows: (kind) => rows[kind],
      online: () => online,
    });
    await controller.refresh();
    expect(controller.active).toBe(false);
    // The timer wakes it ten minutes before the run, and lets go five minutes after.
    vi.advanceTimersByTime(minutes(20));
    expect(blocker.start).toHaveBeenCalledTimes(1);
    expect(controller.active).toBe(true);
    controller.update();
    expect(blocker.start).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(minutes(16));
    expect(blocker.stop).toHaveBeenCalledWith(7);
    expect(controller.active).toBe(false);
    rows.turn = [{ status: "running" }];
    mode = "never";
    await controller.refresh();
    expect(controller.active).toBe(false);
    mode = "working";
    await controller.refresh();
    expect(controller.active).toBe(true);
    // A daemon that went away may have left a turn marked running.
    online = false;
    controller.update();
    expect(controller.active).toBe(false);
    online = true;
    controller.update();
    expect(controller.active).toBe(true);
    controller.close();
    expect(blocker.stop).toHaveBeenCalledTimes(3);
  });
});

it("keeps the latest mode when reads finish out of order", async () => {
  const blocker = { start: vi.fn(() => 1), stop: vi.fn() };
  const reads: ((mode: "never" | "working") => void)[] = [];
  const controller = keepAwakeController({
    blocker,
    mode: () => new Promise((done) => reads.push(done)),
    rows: (kind) => (kind === "turn" ? [{ status: "running" }] : []),
    online: () => true,
  });
  const first = controller.refresh();
  const second = controller.refresh();
  reads[1]?.("working");
  await second;
  reads[0]?.("never");
  await first;
  expect(controller.active).toBe(true);
  controller.close();
});
