import { describe, expect, it } from "vitest";
import { checkOutcome, launchLock, nextLock, readLockPrefs, unlocked } from "./app-lock.js";

const on = { enabled: true, after: 60 } as const;
const t0 = 1_000_000;

describe("app lock", () => {
  it("reads saved preferences, falling back for anything odd", () => {
    expect(readLockPrefs({ enabled: true, after: 300 })).toEqual({ enabled: true, after: 300 });
    expect(readLockPrefs({ enabled: "yes", after: 42 })).toEqual({ enabled: false, after: 60 });
    expect(readLockPrefs(null)).toEqual({ enabled: false, after: 60 });
  });

  it("locks on launch only when turned on", () => {
    expect(launchLock(on)).toEqual({ locked: true, covered: true });
    expect(launchLock({ enabled: false, after: 0 })).toEqual({ locked: false, covered: false });
  });

  it("covers the snapshot when inactive, without locking for Face ID's own prompt", () => {
    const shown = nextLock(unlocked(), "inactive", on, t0);
    expect(shown).toEqual({ locked: false, covered: true });
    expect(nextLock(shown, "active", on, t0 + 120_000)).toEqual({ locked: false, covered: false });
  });

  it("locks after the chosen time in the background", () => {
    const away = nextLock(nextLock(unlocked(), "inactive", on, t0), "background", on, t0);
    expect(away.leftAt).toBe(t0);
    expect(nextLock(away, "active", on, t0 + 59_000)).toEqual({ locked: false, covered: false });
    expect(nextLock(away, "active", on, t0 + 60_000)).toEqual({ locked: true, covered: true });
    // A clock that went backwards locks too.
    expect(nextLock(away, "active", on, t0 - 1).locked).toBe(true);
  });

  it("locks at once with Immediately, and stays locked until unlocked", () => {
    const now = { enabled: true, after: 0 } as const;
    const away = nextLock(unlocked(), "background", now, t0);
    const back = nextLock(away, "active", now, t0);
    expect(back.locked).toBe(true);
    expect(nextLock(back, "inactive", now, t0).locked).toBe(true);
    expect(nextLock(back, "active", now, t0).locked).toBe(true);
  });

  it("never locks or covers when turned off", () => {
    const off = { enabled: false, after: 0 } as const;
    expect(nextLock({ locked: true, covered: true }, "background", off, t0)).toEqual({
      locked: false,
      covered: false,
    });
  });
});

describe("checkOutcome", () => {
  it("tells backing out from a phone that can't check, and from a failed check", () => {
    expect(checkOutcome({ success: true })).toBe("ok");
    expect(checkOutcome({ success: false, error: "user_cancel" })).toBe("cancelled");
    expect(checkOutcome({ success: false, error: "system_cancel" })).toBe("cancelled");
    expect(checkOutcome({ success: false, error: "passcode_not_set" })).toBe("unavailable");
    expect(checkOutcome({ success: false, error: "not_enrolled" })).toBe("unavailable");
    expect(checkOutcome({ success: false, error: "lockout" })).toBe("failed");
    expect(checkOutcome({ success: false })).toBe("failed");
  });
});
