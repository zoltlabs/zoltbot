// Desktop-only preferences. Preferences that agents or the phone need live in
// the daemon's settings instead.

export const PREFERENCE_CHANNELS = {
  preferencesGet: "preferences:get",
  preferencesSet: "preferences:set",
  preferencesEvent: "preferences:event",
} as const;

export type ThemePreference = "system" | "light" | "dark";
export type TextSizePreference = "default" | "large" | "larger";
/** C14: which key sends a message; the other adds a new line. */
export type SendKeyPreference = "enter" | "mod-enter";

export interface Preferences {
  theme: ThemePreference;
  textSize: TextSizePreference;
  sounds: boolean;
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
  sounds: true,
  keyBindings: Object.freeze({}) as Record<string, string>,
  showInDock: true,
  hideConfirmed: false,
  sendKey: "enter",
});

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];
const TEXT_SIZES: readonly TextSizePreference[] = ["default", "large", "larger"];

type Validators = { [K in keyof Preferences]: (value: unknown) => value is Preferences[K] };

const VALIDATORS: Validators = {
  theme: (value): value is ThemePreference => THEMES.includes(value as ThemePreference),
  textSize: (value): value is TextSizePreference =>
    TEXT_SIZES.includes(value as TextSizePreference),
  sounds: (value): value is boolean => typeof value === "boolean",
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
