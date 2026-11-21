// Desktop-only preferences. Preferences that agents or the phone need live in
// the daemon's settings instead.

export const PREFERENCE_CHANNELS = {
  preferencesGet: "preferences:get",
  preferencesSet: "preferences:set",
  preferencesEvent: "preferences:event",
} as const;

export type ThemePreference = "system" | "light" | "dark";
export type TextSizePreference = "small" | "default" | "large" | "larger";
/** D1: the interface font, from the stacks the app bundles or the system has. */
export type FontPreference = "system" | "geist" | "serif";
/** D1: the fill behind a chat's messages. */
export type ChatBackgroundPreference = "none" | "tint" | "dots" | "grid";

/** D1: each text size as a scale of the whole interface. */
export const TEXT_SCALE: Readonly<Record<TextSizePreference, number>> = Object.freeze({
  small: 0.875,
  default: 1,
  large: 1.125,
  larger: 1.25,
});
/** C14: which key sends a message; the other adds a new line. */
export type SendKeyPreference = "enter" | "mod-enter";

export interface Preferences {
  theme: ThemePreference;
  textSize: TextSizePreference;
  font: FontPreference;
  chatBackground: ChatBackgroundPreference;
  sounds: boolean;
  /** D2: each sound, under the `sounds` switch. */
  soundTaskFinished: boolean;
  soundNeedsYou: boolean;
  soundMessageSent: boolean;
  /** D2: 0 to 1. */
  soundVolume: number;
  /** Shortcut id → key combination, only for shortcuts the owner rebound. */
  keyBindings: Record<string, string>;
  showInDock: boolean;
  /** C5: the owner has seen that hiding a message doesn't make the agent forget it. */
  hideConfirmed: boolean;
  sendKey: SendKeyPreference;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: "system",
  textSize: "default",
  font: "system",
  chatBackground: "none",
  sounds: true,
  soundTaskFinished: true,
  soundNeedsYou: true,
  soundMessageSent: true,
  soundVolume: 0.6,
  keyBindings: Object.freeze({}) as Record<string, string>,
  showInDock: true,
  hideConfirmed: false,
  sendKey: "enter",
});

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];
const TEXT_SIZES = Object.keys(TEXT_SCALE) as TextSizePreference[];
export const FONTS: readonly FontPreference[] = ["system", "geist", "serif"];
export const CHAT_BACKGROUNDS: readonly ChatBackgroundPreference[] = [
  "none",
  "tint",
  "dots",
  "grid",
];

type Validators = { [K in keyof Preferences]: (value: unknown) => value is Preferences[K] };

const VALIDATORS: Validators = {
  theme: (value): value is ThemePreference => THEMES.includes(value as ThemePreference),
  textSize: (value): value is TextSizePreference =>
    TEXT_SIZES.includes(value as TextSizePreference),
  font: (value): value is FontPreference => FONTS.includes(value as FontPreference),
  chatBackground: (value): value is ChatBackgroundPreference =>
    CHAT_BACKGROUNDS.includes(value as ChatBackgroundPreference),
  sounds: (value): value is boolean => typeof value === "boolean",
  soundTaskFinished: (value): value is boolean => typeof value === "boolean",
  soundNeedsYou: (value): value is boolean => typeof value === "boolean",
  soundMessageSent: (value): value is boolean => typeof value === "boolean",
  soundVolume: (value): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
  keyBindings: (value): value is Record<string, string> =>
    isRecord(value) &&
    Object.entries(value).every(([id, keys]) => id.length > 0 && typeof keys === "string"),
  showInDock: (value): value is boolean => typeof value === "boolean",
  hideConfirmed: (value): value is boolean => typeof value === "boolean",
  sendKey: (value): value is SendKeyPreference => value === "enter" || value === "mod-enter",
};

export const PREFERENCE_KEYS = Object.keys(VALIDATORS) as (keyof Preferences)[];

/** Keeps each valid value and falls back to the default for anything missing or invalid. */
export function normalizePreferences(raw: unknown): Preferences {
  const source = isRecord(raw) ? raw : {};
  const result = { ...DEFAULT_PREFERENCES, keyBindings: {} } as Preferences;
  for (const key of PREFERENCE_KEYS) {
    const value = source[key];
    if (VALIDATORS[key](value)) (result as unknown as Record<string, unknown>)[key] = value;
  }
  result.keyBindings = { ...result.keyBindings };
  return result;
}

/** Validates a partial update. Throws on an unknown key or an invalid value. */
export function parsePreferencesPatch(raw: unknown): Partial<Preferences> {
  if (!isRecord(raw)) throw new Error("Preferences update must be an object.");
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in VALIDATORS)) throw new Error(`Unknown preference: ${key}`);
    if (!VALIDATORS[key as keyof Preferences](value))
      throw new Error(`Invalid value for preference: ${key}`);
    patch[key] = value;
  }
  return patch as Partial<Preferences>;
}

export interface PreferencesDesktopApi {
  get: () => Promise<Preferences>;
  set: (patch: Partial<Preferences>) => Promise<Preferences>;
  onChange: (listener: (preferences: Preferences) => void) => () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
