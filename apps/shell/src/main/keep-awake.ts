// R4: keep the Mac from sleeping while agents work, or shortly before a routine is due. A pure
// decision plus a small controller around Electron's power save blocker, injected for tests.

/** "never": the Mac sleeps as usual. */
export type KeepAwakeMode = "never" | "working" | "working-or-due";

/** How early before a routine's run the Mac stays awake. */
export const KEEP_AWAKE_LEAD_MS = 10 * 60_000;
/** A routine this late has missed its run; it no longer holds the Mac awake. */
export const KEEP_AWAKE_LATE_MS = 5 * 60_000;

type Row = Record<string, unknown>;

/** The soonest run of any routine that will run on its own: not paused, not done, not on events. */
export function nextRoutineAt(routines: readonly Row[]): number | undefined {
  let soonest: number | undefined;
  for (const routine of routines) {
    if (routine.paused === true || routine.doneAt || routine.event) continue;
    const at = typeof routine.nextRunAt === "string" ? Date.parse(routine.nextRunAt) : Number.NaN;
    if (Number.isFinite(at) && (soonest === undefined || at < soonest)) soonest = at;
  }
  return soonest;
}

/** Whether any chat turn or task is running. */
export function agentsWorking(turns: readonly Row[], tasks: readonly Row[]): boolean {
  return (
    turns.some((turn) => turn.status === "running") ||
    tasks.some((task) => task.state === "running")
  );
}

export function shouldKeepAwake(
  mode: KeepAwakeMode,
  state: { working: boolean; nextRoutineAt: number | undefined; now: number },
): boolean {
  if (mode === "never") return false;
  if (state.working) return true;
  if (mode !== "working-or-due" || state.nextRoutineAt === undefined) return false;
  const until = state.nextRoutineAt - state.now;
  return until <= KEEP_AWAKE_LEAD_MS && until >= -KEEP_AWAKE_LATE_MS;
}

/** When the decision can next change on its own, with nothing else happening. */
export function nextCheckAt(
  mode: KeepAwakeMode,
  nextRoutine: number | undefined,
  now: number,
): number | undefined {
  if (mode !== "working-or-due" || nextRoutine === undefined) return undefined;
  const opens = nextRoutine - KEEP_AWAKE_LEAD_MS;
  const closes = nextRoutine + KEEP_AWAKE_LATE_MS;
  if (now < opens) return opens;
  if (now <= closes) return closes + 1;
  return undefined;
}

export interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

/** Starts and stops one blocker as the mode and the daemon's rows change. */
export function keepAwakeController(options: {
  blocker: PowerBlocker;
  mode: () => Promise<KeepAwakeMode> | KeepAwakeMode;
  rows: (kind: "turn" | "task" | "routine") => readonly Row[];
  /** False while the daemon is unreachable: its last rows may show work that has stopped. */
  online: () => boolean;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let blockerId: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let mode: KeepAwakeMode = "never";
  let closed = false;
  let reads = 0;

  function apply() {
    if (closed) return;
    const at = now();
    const online = options.online();
    const next = online ? nextRoutineAt(options.rows("routine")) : undefined;
    const keep = shouldKeepAwake(mode, {
      working: online && agentsWorking(options.rows("turn"), options.rows("task")),
      nextRoutineAt: next,
      now: at,
    });
    if (keep && blockerId === undefined)
      blockerId = options.blocker.start("prevent-app-suspension");
    if (!keep && blockerId !== undefined) {
      options.blocker.stop(blockerId);
      blockerId = undefined;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    const check = nextCheckAt(mode, next, at);
    // Timers longer than about 24 days overflow; an hourly look is plenty past that.
    if (check !== undefined)
      timer = setTimeout(apply, Math.min(Math.max(check - at, 1_000), 3_600_000));
  }

  return {
    /** Re-reads the mode, then decides. */
    async refresh() {
      // Only the latest read counts, when an older one finishes last.
      const read = ++reads;
      let next: KeepAwakeMode;
      try {
        next = await options.mode();
      } catch {
        next = "never";
      }
      if (read !== reads) return;
      mode = next;
      apply();
    },
    /** Decides again with the same mode, after the daemon's rows change. */
    update: apply,
    get active() {
      return blockerId !== undefined;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (blockerId !== undefined) options.blocker.stop(blockerId);
      blockerId = undefined;
    },
  };
}
