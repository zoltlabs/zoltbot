// Interface text for the desktop app. Every string a person reads goes through t(), with its
// English text in en.json under a key named by place and meaning, such as "chat.message.copy".
// apps/mobile/src/i18n has the same shape for the phone.
import { createSignal } from "solid-js";
import { LANGUAGES, type Language, type LanguagePreference } from "../../../shared/preferences";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import { formatMessage, type MessageParams } from "./format";
import fr from "./fr.json";
import ja from "./ja.json";
import ptBR from "./pt-BR.json";
import zhCN from "./zh-CN.json";

export type MessageKey = keyof typeof en;
export type { MessageParams } from "./format";

const catalogs: Record<string, Partial<Record<MessageKey, string>>> = {
  en,
  es,
  de,
  fr,
  ja,
  "pt-BR": ptBR,
  "zh-CN": zhCN,
};

/** Each language's name in itself, as language menus show them. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
  ja: "日本語",
  "pt-BR": "Português (Brasil)",
  "zh-CN": "简体中文",
};

/**
 * The language to show: the owner's choice, or the first of the system's preferred languages
 * the app comes in, matching by language when the region differs. English otherwise.
 */
export function resolveLanguage(
  preference: LanguagePreference,
  system: readonly string[],
): Language {
  if (preference !== "system") return preference;
  for (const tag of system) {
    const exact = LANGUAGES.find((language) => language.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const base = tag.toLowerCase().split("-")[0];
    // Traditional Chinese isn't offered; Simplified would be the wrong script.
    if (base === "zh" && /hant|tw|hk|mo/i.test(tag)) continue;
    const byLanguage = LANGUAGES.find((language) => language.toLowerCase().split("-")[0] === base);
    if (byLanguage) return byLanguage;
  }
  return "en";
}
const [locale, setLocaleSignal] = createSignal("en");

export { locale };

/** Switches the interface language. Keys missing from that language fall back to English. */
export function setLocale(next: string): void {
  setLocaleSignal(catalogs[next] ? next : "en");
}

/** The interface text for `key`, with `params` filled in. Reactive to the locale. */
export function t(key: MessageKey, params: MessageParams = {}): string {
  const current = locale();
  const source = catalogs[current]?.[key] ?? en[key];
  return formatMessage(source, params, current);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale(), options).format(value);
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale(), options).format(value);
}

/** "Ada, Kai and Mo", or "Ada, Kai or Mo" with `type: "disjunction"`. */
export function formatList(items: readonly string[], options?: Intl.ListFormatOptions): string {
  return new Intl.ListFormat(locale(), { style: "long", type: "conjunction", ...options }).format(
    items,
  );
}
