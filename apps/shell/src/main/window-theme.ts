import type { BrowserWindow, NativeTheme } from "electron";

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
