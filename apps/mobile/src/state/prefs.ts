import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";
export interface Prefs {
  theme: ThemePreference;
  set(patch: Partial<Omit<Prefs, "set">>): void;
}

/** Theme stays on this phone. Other preferences live in Mac settings. */
export const usePrefs = create<Prefs>((set) => ({
  theme: "system",
  set: (patch) => set(patch),
}));
