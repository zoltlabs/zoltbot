import { useColorScheme } from "react-native";
import { scaleText } from "../data/text-size";
import { usePrefs } from "../state/prefs";
import { useTextSize } from "../state/text-size";
import { dark, light, type Tokens } from "./tokens.generated";

export type { Tokens };
export type Scheme = "light" | "dark";

/**
 * Geist, as on the desktop. The expo-font plugin embeds the static weights at build time. iOS
 * groups them under one family by itself; on Android app.json declares the family, weight by weight.
 * Both then pick the face from fontWeight.
 */
export const sans = "Geist";
export const mono = "Geist Mono";

/** Mobile text sizes. Body copy is larger than desktop because phones are read at arm's length. */
export const type = {
  largeTitle: {
    fontFamily: sans,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  cardTitle: { fontFamily: sans, fontSize: 17, lineHeight: 22, fontWeight: "600" },
  body: { fontFamily: sans, fontSize: 15, lineHeight: 21, fontWeight: "400" },
  bodyMedium: { fontFamily: sans, fontSize: 15, lineHeight: 21, fontWeight: "500" },
  section: { fontFamily: sans, fontSize: 15, lineHeight: 20, fontWeight: "600" },
  meta: { fontFamily: sans, fontSize: 13, lineHeight: 18, fontWeight: "400" },
  chip: { fontFamily: sans, fontSize: 13, lineHeight: 18, fontWeight: "500" },
  tab: { fontFamily: sans, fontSize: 11, lineHeight: 13, fontWeight: "500" },
  code: { fontSize: 13, lineHeight: 18, fontFamily: mono },
} as const;
type TypeScale = typeof type;
const scales = new Map<number, TypeScale>();
/** P6: the type scale at the owner's text size. Dynamic Type still applies on top. */
export function useType(): TypeScale {
  const size = useTextSize((state) => state.size);
  let scale = scales.get(size);
  if (!scale) {
    scale = Object.fromEntries(
      Object.entries(type).map(([name, style]) => [name, scaleText(style, size)]),
    ) as TypeScale;
    scales.set(size, scale);
  }
  return scale;
}
/** P6: the owner's text size, for the few sizes set outside the type scale. */
export const useTextScale = () => useTextSize((state) => state.size);

/** The smallest thing a finger should have to hit (Apple HIG). */
export const touch = 44;

/** Avatar hue n (1..8) and its eye tint, from the tokens. */
export function avatarColors(tokens: Tokens, hue: number) {
  const n = Math.min(8, Math.max(1, hue)) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  return {
    body: tokens[`avatar-${n}`],
    eye: tokens[`character-eye-${n}`],
    screen: tokens["character-screen"],
  };
}

/** Follows the system setting unless the person picked light or dark in Settings. */
export function useTheme(): { scheme: Scheme; c: Tokens } {
  const system = useColorScheme();
  const preference = usePrefs((state) => state.theme);
  const scheme: Scheme =
    preference === "system" ? (system === "light" ? "light" : "dark") : preference;
  return { scheme, c: scheme === "light" ? light : dark };
}
