import { describe, expect, it } from "vitest";
import { canvasToPage, mouseButton, pageKey } from "../shared/agent-browser-input";

describe("takeover input mapping", () => {
  it("scales canvas points to page pixels", () => {
    const shown = { width: 512, height: 360 };
    const page = { width: 1024, height: 720 };
    expect(canvasToPage({ x: 0, y: 0 }, shown, page)).toEqual({ x: 0, y: 0 });
    expect(canvasToPage({ x: 256, y: 180 }, shown, page)).toEqual({ x: 512, y: 360 });
    expect(canvasToPage({ x: 512, y: 360 }, shown, page)).toEqual({ x: 1024, y: 720 });
    expect(canvasToPage({ x: 100.3, y: 33.3 }, shown, page)).toEqual({ x: 200.6, y: 66.6 });
  });

  it("drops points outside the page and empty sizes", () => {
    const page = { width: 1024, height: 720 };
    expect(canvasToPage({ x: -1, y: 4 }, { width: 512, height: 360 }, page)).toBeUndefined();
    expect(canvasToPage({ x: 4, y: 361 }, { width: 512, height: 360 }, page)).toBeUndefined();
    expect(canvasToPage({ x: 4, y: 4 }, { width: 0, height: 0 }, page)).toBeUndefined();
  });

  it("maps buttons and keeps app shortcuts out of the page", () => {
    expect([0, 1, 2, 7].map(mouseButton)).toEqual(["left", "middle", "right", "left"]);
    expect(pageKey({ key: "a", metaKey: false })).toBe("a");
    expect(pageKey({ key: "Enter", metaKey: false })).toBe("Enter");
    expect(pageKey({ key: "w", metaKey: true })).toBeUndefined();
    expect(pageKey({ key: "Dead", metaKey: false })).toBeUndefined();
  });
});
