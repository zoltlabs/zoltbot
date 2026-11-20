import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";
export interface Prefs {
  theme: ThemePreference;
  /** C5: the owner has seen that a hidden message stays in the agent's memory. */
  hideConfirmed: boolean;
  set(patch: Partial<Omit<Prefs, "set">>): void;
}

/** Theme stays on this phone. Other preferences live in Mac settings. */
export const usePrefs = create<Prefs>((set) => ({
  theme: "system",
  hideConfirmed: false,
  set: (patch) => set(patch),
}));
