import { describe, expect, it } from "vitest";
import {
  click,
  fit,
  movePointer,
  press,
  readFrame,
  readState,
  screenError,
  scroll,
  shortUrl,
  toPage,
  typeText,
} from "./browser-screen";

const page = { width: 1024, height: 720 };

describe("frames", () => {
  const good = {
    threadId: "t1",
    data: "anBlZw==",
    width: 1024,
    height: 720,
    url: "https://a.test/",
  };
  it("keeps a well-formed frame for this chat", () => {
    expect(readFrame(good, "t1")).toEqual(good);
  });
  it("drops frames for another chat or that are malformed", () => {
    for (const bad of [
      { ...good, threadId: "t2" },
      { ...good, data: "" },
      { ...good, data: "<script>" },
      { ...good, data: "A".repeat(600 * 1024) },
      { ...good, width: 0 },
      { ...good, height: Number.NaN },
      null,
      "frame",
    ])
      expect(readFrame(bad, "t1")).toBeUndefined();
  });
  it("reads the view state defensively", () => {
    expect(readState({ running: true, url: "https://a.test/", control: true })).toEqual({
      running: true,
      url: "https://a.test/",
      control: true,
    });
    expect(readState(null)).toEqual({ running: false, url: null, control: false });
    expect(shortUrl("https://a.test/path/")).toBe("a.test/path");
  });
});

describe("touch mapping", () => {
  // A phone-width picture: the page fits the width, with bands above and below.
  const box = { width: 390, height: 600 };
  it("fits the page and maps a tap to page pixels", () => {
    const at = fit(box, page);
    expect(at.width).toBeCloseTo(390);
    expect(at.top).toBeGreaterThan(0);
    expect(toPage({ x: 195, y: 300 }, box, page)).toEqual({ x: 512, y: 360 });
    expect(toPage({ x: 0, y: at.top }, box, page)).toEqual({ x: 0, y: 0 });
    // The band outside the picture is not the page.
    expect(toPage({ x: 10, y: 5 }, box, page)).toBeUndefined();
  });
  it("clicks with a move, press and release at one point", () => {
    expect(click({ x: 5, y: 6 }).map((e) => e.type)).toEqual(["move", "down", "up"]);
  });
  it("scrolls the way the finger moved, in page pixels", () => {
    const { scale } = fit(box, page);
    const wheel = scroll({ x: 1, y: 2 }, { x: 0, y: -100 }, scale);
    expect(wheel).toMatchObject({ kind: "mouse", type: "wheel", x: 1, y: 2, deltaX: 0 });
    expect((wheel as { deltaY: number }).deltaY).toBeGreaterThan(100);
  });
  it("moves a trackpad pointer and keeps it on the page", () => {
    expect(movePointer({ x: 10, y: 10 }, { x: -50, y: 20 }, 0.5, page)).toEqual({ x: 0, y: 50 });
    expect(movePointer({ x: 1000, y: 700 }, { x: 100, y: 100 }, 1, page)).toEqual({
      x: 1024,
      y: 720,
    });
  });
});

describe("keyboard", () => {
  it("types text in pieces the Mac accepts, keeping characters whole", () => {
    const pieces = typeText("😀".repeat(20));
    expect(pieces).toHaveLength(2);
    for (const piece of pieces)
      expect((piece as { key: string }).key.length).toBeLessThanOrEqual(32);
    expect(pieces.map((p) => (p as { key: string }).key).join("")).toBe("😀".repeat(20));
    expect(typeText("")).toEqual([]);
  });
  it("presses a named key", () => {
    expect(press("Enter")).toEqual([
      { kind: "key", type: "down", key: "Enter" },
      { kind: "key", type: "up", key: "Enter" },
    ]);
  });
  it("words refusals for the screen", () => {
    expect(screenError(new Error("browser_not_running"), true)).toBe("The browser closed.");
    expect(screenError(new Error("x"), true)).toBe("Couldn’t take over. Try again.");
    expect(screenError(new Error("x"), false)).toBe("Couldn’t hand back. Try again.");
  });
});
