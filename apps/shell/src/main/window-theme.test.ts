import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WINDOW_BACKGROUND, windowBackground } from "./window-theme";

const themeCss = readFileSync(new URL("../renderer/src/theme.css", import.meta.url), "utf8");

function mainBackground(block: string): string | undefined {
  return /--openbot-main:\s*(#[0-9a-f]{6});/i.exec(block)?.[1];
}

describe("windowBackground", () => {
  it("picks the background for the system appearance", () => {
    expect(windowBackground({ shouldUseDarkColors: true })).toBe(WINDOW_BACKGROUND.dark);
    expect(windowBackground({ shouldUseDarkColors: false })).toBe(WINDOW_BACKGROUND.light);
  });

  it("matches the renderer's main background in each theme", () => {
    const light = themeCss.indexOf("@media (prefers-color-scheme: light)");
    expect(mainBackground(themeCss.slice(0, light))).toBe(WINDOW_BACKGROUND.dark);
    expect(mainBackground(themeCss.slice(light))).toBe(WINDOW_BACKGROUND.light);
  });
});
