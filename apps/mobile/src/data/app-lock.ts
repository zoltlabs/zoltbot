// P2: when the app asks for Face ID or the passcode again. Pure, so the rules are testable.

export const lockAfterOptions = [0, 60, 300, 900] as const;
export type LockAfter = (typeof lockAfterOptions)[number];
export const lockAfterLabels: Record<LockAfter, string> = {
  0: "Immediately",
  60: "1 minute",
  300: "5 minutes",
  900: "15 minutes",
};

export interface LockPrefs {
  enabled: boolean;
  /** Seconds in the background before the app locks. */
  after: LockAfter;
}
export const defaultLockPrefs: LockPrefs = { enabled: false, after: 60 };

export function readLockPrefs(value: unknown): LockPrefs {
  const row = value && typeof value === "object" ? (value as Partial<LockPrefs>) : {};
  return {
    enabled: row.enabled === true,
    after: lockAfterOptions.includes(row.after as LockAfter)
      ? (row.after as LockAfter)
      : defaultLockPrefs.after,
  };
}

export type AppPhase = "active" | "inactive" | "background";
export interface LockState {
  locked: boolean;
  /** Covers the app-switcher snapshot while the app is not in front. */
  covered: boolean;
  /** When the app last went to the background; Face ID's own prompt only makes it inactive. */
  leftAt?: number;
}

/** The state on launch: locked when the lock is on. */
export const launchLock = (prefs: LockPrefs): LockState => ({
  locked: prefs.enabled,
  covered: prefs.enabled,
});

/** The next state when the app moves between active, inactive and background. */
export function nextLock(
  state: LockState,
  phase: AppPhase,
  prefs: LockPrefs,
  now: number,
): LockState {
  if (!prefs.enabled) return { locked: false, covered: false };
  if (phase === "inactive") return { ...state, covered: true };
  if (phase === "background") return { ...state, covered: true, leftAt: state.leftAt ?? now };
  const away = state.leftAt === undefined ? 0 : now - state.leftAt;
  const locked =
    state.locked || (state.leftAt !== undefined && (away < 0 || away >= prefs.after * 1000));
  return { locked, covered: locked };
}

/** After a successful Face ID or passcode check. */
export const unlocked = (): LockState => ({ locked: false, covered: false });
