import type { BrowserWindow, NativeTheme } from "electron";
import { type Preferences, TEXT_SCALE } from "../shared/preferences";

/** Window backgrounds matching `--openbot-main` in renderer/src/theme.css, so no flash shows. */
export const WINDOW_BACKGROUND = { dark: "#080808", light: "#ffffff" } as const;

export function windowBackground(theme: Pick<NativeTheme, "shouldUseDarkColors">): string {
  return theme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
}

/** Keeps the window background in step with the system appearance. Returns a cleanup. */
export function followWindowTheme(window: BrowserWindow, theme: NativeTheme): () => void {
  const update = () => {
    if (!window.isDestroyed()) window.setBackgroundColor(windowBackground(theme));
  };
  theme.on("updated", update);
  return () => theme.off("updated", update);
}

/**
 * D1: the owner's theme and text size. The window, its title bar and the renderer's
 * prefers-color-scheme all follow the theme, so the renderer needs no second source. Text size
 * is the page's zoom factor: it scales layout and pointer coordinates together, so menus and
 * resizers stay under the pointer.
 */
export function appearanceFollower(theme: Pick<NativeTheme, "themeSource">) {
  let scale = 1;
  const zoom = (window: BrowserWindow) => {
    if (!window.isDestroyed()) window.webContents.setZoomFactor(scale);
  };
  return {
    apply(preferences: Pick<Preferences, "theme" | "textSize">, windows: BrowserWindow[] = []) {
      theme.themeSource = preferences.theme;
      scale = TEXT_SCALE[preferences.textSize];
      for (const window of windows) zoom(window);
    },
    /** Keeps a window at the chosen size across reloads. */
    attach(window: BrowserWindow) {
      window.webContents.on("did-finish-load", () => zoom(window));
    },
  };
}
