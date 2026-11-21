// D9: shows the interface in the owner's language and follows changes to it.
import { createRoot, createSignal } from "solid-js";
import {
  type LanguagePreference,
  normalizePreferences,
  type Preferences,
} from "../../../shared/preferences";
import { resolveLanguage, setLocale } from ".";

const [preferred, setPreferred] = createRoot(() => createSignal<LanguagePreference>("system"));
/** The owner's choice: a language, or "system". */
export const languagePreference = preferred;

function systemLanguages(): readonly string[] {
  return typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
}

// The last choice, kept so the next launch paints in it before the saved one loads.
const CACHE = "zoltbot.language";
function cached(): LanguagePreference {
  try {
    return normalizePreferences({ language: localStorage.getItem(CACHE) }).language;
  } catch {
    return "system";
  }
}

/** Sets the language now, and on <html> for screen readers and line breaking. */
export function applyLanguage(preference: LanguagePreference, root = document.documentElement) {
  setPreferred(preference);
  try {
    localStorage.setItem(CACHE, preference);
  } catch {
    // Storage is off; the saved choice still loads, a moment later.
  }
  const language = resolveLanguage(preference, systemLanguages());
  setLocale(language);
  root.lang = language;
}

/** Saves the owner's choice and shows it at once. */
export let chooseLanguage = (language: LanguagePreference) => applyLanguage(language);

let started = false;
/** Reads the saved language once and follows later changes. */
export function followLanguage(): void {
  if (started) return;
  started = true;
  applyLanguage(cached());
  const preferences = window.openbot?.preferences;
  if (!preferences) return;
  const take = (value: Preferences) => applyLanguage(value.language);
  chooseLanguage = (language) => {
    applyLanguage(language);
    void preferences.set({ language }).catch(() => undefined);
  };
  void preferences
    .get()
    .then(take)
    .catch(() => undefined);
  preferences.onChange(take);
}
