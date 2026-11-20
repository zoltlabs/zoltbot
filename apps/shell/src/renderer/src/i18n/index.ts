// Interface text for the desktop app. Every string a person reads goes through t(), with its
// English text in en.json under a key named by place and meaning, such as "chat.message.copy".
// apps/mobile/src/i18n has the same shape for the phone.
import { createSignal } from "solid-js";
import en from "./en.json";
import { formatMessage, type MessageParams } from "./format";

export type MessageKey = keyof typeof en;
export type { MessageParams } from "./format";

const catalogs: Record<string, Partial<Record<MessageKey, string>>> = { en };
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
