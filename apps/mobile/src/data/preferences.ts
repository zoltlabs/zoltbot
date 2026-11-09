import type { Row } from "./transport.js";

export const phoneDefaults = {
  notifyNeedsYou: true,
  notifyResults: true,
  /** Notices the main agent sends you; a relay that predates them never delivers them. */
  notifyZolt: true,
  pushTitles: false,
  keepAwake: true,
};
export type PhonePrefs = typeof phoneDefaults;
export type PhonePref = keyof PhonePrefs;
export const preferenceKey = (deviceId: string, field: PhonePref) => `mobile.${deviceId}.${field}`;
export function readPhonePrefs(rows: Row[], deviceId: string): PhonePrefs {
  const prefs = { ...phoneDefaults };
  for (const field of Object.keys(prefs) as PhonePref[]) {
    const value = rows.find((row) => row.key === preferenceKey(deviceId, field))?.value;
    if (typeof value === "boolean") prefs[field] = value;
  }
  return prefs;
}

export const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
/** "8:30", "830" or "08:30" as "08:30"; undefined when it is not a time of day. */
export function readClock(value: string): string | undefined {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 4) return undefined;
  const time = `${digits.slice(0, -2).padStart(2, "0")}:${digits.slice(-2)}`;
  return clock.test(time) ? time : undefined;
}
