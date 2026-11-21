import { describe, expect, it } from "vitest";
import { HoldKey, MIN_HOLD_MS, type PushToTalkKey } from "./push-to-talk";

const machine = (key: PushToTalkKey = "Fn") => {
  let current = key;
  const hold = new HoldKey(() => current);
  return { hold, setKey: (next: PushToTalkKey) => (current = next) };
};
const down = (code: string, at = 0, repeat = false) => ({
  type: "down" as const,
  code,
  at,
  repeat,
});
const up = (code: string, at: number) => ({ type: "up" as const, code, at });
const tick = (at: number) => ({ type: "tick" as const, at });

describe("push to talk key", () => {
  it("starts once held long enough and stops on release", () => {
    const { hold } = machine();
    expect(hold.handle(down("Fn"))).toBeUndefined();
    expect(hold.handle(tick(MIN_HOLD_MS - 1))).toBeUndefined();
    expect(hold.handle(tick(MIN_HOLD_MS))).toBe("start");
    expect(hold.handle(tick(MIN_HOLD_MS + 50))).toBeUndefined();
    expect(hold.handle(down("Fn", 400, true))).toBeUndefined();
    expect(hold.handle(up("Fn", 900))).toBe("stop");
    expect(hold.holding).toBe(false);
  });

  it("never starts for a tap", () => {
    const { hold } = machine();
    hold.handle(down("Fn"));
    expect(hold.handle(up("Fn", 100))).toBeUndefined();
    expect(hold.handle(tick(MIN_HOLD_MS))).toBeUndefined();
  });

  it("never starts for a quick chord such as ⌥E, and drops a late one", () => {
    const { hold } = machine("AltRight");
    hold.handle(down("AltRight"));
    expect(hold.handle(down("KeyE", 50))).toBeUndefined();
    expect(hold.handle(tick(MIN_HOLD_MS))).toBeUndefined();
    expect(hold.handle(down("AltRight", 300))).toBeUndefined();
    expect(hold.handle(up("AltRight", 900))).toBeUndefined();
    hold.handle(down("AltRight", 1000));
    expect(hold.handle(tick(1000 + MIN_HOLD_MS))).toBe("start");
    expect(hold.handle(down("ArrowUp", 1500))).toBe("cancel");
  });

  it("drops the words when the window loses focus, and forgets a chord", () => {
    const { hold } = machine("MetaRight");
    hold.handle(down("MetaRight"));
    hold.handle(tick(MIN_HOLD_MS));
    expect(hold.handle({ type: "blur" })).toBe("cancel");
    hold.handle(down("MetaRight", 1000));
    hold.handle(down("Tab", 1010));
    hold.handle({ type: "blur" });
    hold.handle(down("MetaRight", 2000));
    expect(hold.handle(tick(2000 + MIN_HOLD_MS))).toBe("start");
  });

  it("does nothing while off, and turning it off mid-hold drops the words", () => {
    const { hold, setKey } = machine();
    hold.handle(down("Fn"));
    hold.handle(tick(MIN_HOLD_MS));
    setKey("off");
    expect(hold.handle(up("Fn", 1000))).toBe("cancel");
    expect(hold.handle(down("Fn", 2000))).toBeUndefined();
  });
});
