// Interface text for the phone app. Every string a person reads goes through t(), with its
// English text in en.json under a key named by place and meaning, such as "kit.cancel".
// apps/shell/src/renderer/src/i18n has the same shape for the desktop.
import en from "./en.json";
import { formatMessage, type MessageParams } from "./format";

export type MessageKey = keyof typeof en;
export type { MessageParams } from "./format";

const catalogs: Record<string, Partial<Record<MessageKey, string>>> = { en };
let locale = "en";

/** Switches the interface language. Keys missing from that language fall back to English. */
export function setLocale(next: string): void {
  locale = catalogs[next] ? next : "en";
}

export function currentLocale(): string {
  return locale;
}

/** The interface text for `key`, with `params` filled in. */
export function t(key: MessageKey, params: MessageParams = {}): string {
  return formatMessage(catalogs[locale]?.[key] ?? en[key], params, locale);
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}
