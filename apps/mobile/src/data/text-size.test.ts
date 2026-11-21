import { describe, expect, it } from "vitest";
import { nearestTextSize, readTextSize, scaleText, textSizeLabel } from "./text-size";

describe("text size", () => {
  it("reads only a known notch, else the default", () => {
    expect(readTextSize("1.3")).toBe(1.3);
    expect(readTextSize("2")).toBe(1);
    expect(readTextSize(null)).toBe(1);
    expect(readTextSize("big")).toBe(1);
  });
  it("snaps a drag to the nearest notch", () => {
    expect(nearestTextSize(0)).toBe(0.85);
    expect(nearestTextSize(0.4)).toBe(1.15);
    expect(nearestTextSize(1.4)).toBe(1.5);
  });
  it("scales size and line height and keeps the rest", () => {
    const body = { fontFamily: "Geist", fontSize: 15, lineHeight: 21, fontWeight: "400" };
    expect(scaleText(body, 1.3)).toEqual({ ...body, fontSize: 20, lineHeight: 27 });
    expect(scaleText(body, 1)).toBe(body);
    expect(scaleText({ fontFamily: "Geist Mono" }, 1.5)).toEqual({ fontFamily: "Geist Mono" });
  });
  it("labels a notch as a percentage", () => {
    expect(textSizeLabel(1.15)).toBe("115%");
  });
});
