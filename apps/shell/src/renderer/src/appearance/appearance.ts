// D1: applies Settings › Appearance to the page. The theme follows prefers-color-scheme, which
// the owner's choice reaches through nativeTheme, and text size is the window's zoom; font and
// chat background are attributes on <html> that appearance.css reads.
import { createRoot, createSignal } from "solid-js";
import {
  DEFAULT_PREFERENCES,
  normalizePreferences,
  type Preferences,
} from "../../../shared/preferences";

export type AppearancePreferences = Pick<
  Preferences,
  "theme" | "textSize" | "font" | "chatBackground"
>;

const pick = (value: Preferences): AppearancePreferences => ({
  theme: value.theme,
  textSize: value.textSize,
  font: value.font,
  chatBackground: value.chatBackground,
});

const [current, setCurrent] = createRoot(() =>
  createSignal<AppearancePreferences>(pick({ ...DEFAULT_PREFERENCES })),
);
export const appearance = current;

/** Writes the choices onto the root element. Text size is the window's zoom, set by main. */
export function applyAppearance(
  root: HTMLElement,
  value: AppearancePreferences,
  dark: boolean,
  keepTheme = false,
) {
  // An explicit theme also tells checks that the system's no longer decides it.
  root.dataset.themeChoice = value.theme;
  if (!keepTheme)
    root.dataset.theme = value.theme === "system" ? (dark ? "dark" : "light") : value.theme;
  root.dataset.font = value.font;
  root.dataset.chatBackground = value.chatBackground;
}

// The last choices, kept so the next launch paints them before the saved ones load.
const CACHE = "zoltbot.appearance";
function cached(): Partial<AppearancePreferences> {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE) ?? "{}") as unknown;
    return value && typeof value === "object" ? (value as Partial<AppearancePreferences>) : {};
  } catch {
    return {};
  }
}
function remember(value: AppearancePreferences) {
  try {
    localStorage.setItem(CACHE, JSON.stringify(value));
  } catch {
    // Storage is off; the saved choices still load, a moment later.
  }
}

let started = false;
// Fields changed while the saved choices load win over the saved ones.
let chosen: Partial<AppearancePreferences> = {};
/** Reads the saved choices once and follows later changes and the system appearance. */
export function followAppearance(root: HTMLElement = document.documentElement): void {
  if (started) return;
  started = true;
  const early = normalizePreferences({ ...DEFAULT_PREFERENCES, ...cached() });
  setCurrent(pick(early));
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const apply = () => applyAppearance(root, current(), media?.matches ?? true);
  apply();
  media?.addEventListener("change", apply);
  const preferences = window.openbot?.preferences;
  if (!preferences) return;
  const take = (value: Preferences) => {
    setCurrent({ ...pick(value), ...chosen });
    remember(current());
    apply();
  };
  void preferences
    .get()
    .then(take)
    .catch(() => undefined)
    .finally(() => {
      chosen = {};
    });
  preferences.onChange(take);
}

/** Saves a change and shows it at once. */
export function setAppearance(patch: Partial<AppearancePreferences>): void {
  chosen = { ...chosen, ...patch };
  setCurrent({ ...current(), ...patch });
  remember(current());
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  // An explicit theme switches the page now. Back to System, the window's own theme is still
  // the forced one until main answers; the media change that follows sets it.
  applyAppearance(
    document.documentElement,
    current(),
    media?.matches ?? true,
    patch.theme === "system",
  );
  void window.openbot?.preferences?.set(patch).catch(() => undefined);
}
