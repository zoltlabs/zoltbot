import { readFileSync } from "node:fs";
import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";
import { appearanceFollower, WINDOW_BACKGROUND, windowBackground } from "./window-theme";

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
    const light = themeCss.indexOf(':root[data-theme="light"]');
    expect(mainBackground(themeCss.slice(0, light))).toBe(WINDOW_BACKGROUND.dark);
    expect(mainBackground(themeCss.slice(light))).toBe(WINDOW_BACKGROUND.light);
  });
});

describe("appearanceFollower", () => {
  it("sets the theme source and zooms open windows and reloaded ones to the text size", () => {
    const theme = { themeSource: "system" as "system" | "light" | "dark" };
    const loads: (() => void)[] = [];
    const zooms: number[] = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        setZoomFactor: (factor: number) => zooms.push(factor),
        on: (_event: string, listener: () => void) => loads.push(listener),
      },
    } as unknown as BrowserWindow;
    const follower = appearanceFollower(theme);
    follower.attach(window);
    follower.apply({ theme: "light", textSize: "larger" }, [window]);
    expect(theme.themeSource).toBe("light");
    expect(zooms).toEqual([1.25]);
    for (const load of loads) load();
    expect(zooms).toEqual([1.25, 1.25]);
  });
});
