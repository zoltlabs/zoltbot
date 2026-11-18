import { createContext, useContext } from "react";

export { assignHues, avatarHue, avatarHues } from "./bot-avatar-shapes.js";

/** Profile id to hue for the profiles the app knows; Avatar falls back to the hash. */
export const ProfileHues = createContext<ReadonlyMap<string, number>>(new Map());
export function useProfileHue(id: string | undefined) {
  const hues = useContext(ProfileHues);
  return id === undefined ? undefined : hues.get(id);
}

export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toUpperCase();
}
