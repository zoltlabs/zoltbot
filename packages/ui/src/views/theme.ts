import type { Theme } from "@zoltbot/view-api";
export function viewTheme(): Theme {
  const root = document.documentElement,
    style = getComputedStyle(root),
    tokens: Record<string, string> = {};
  for (const name of Array.from(style))
    if (name.startsWith("--zb-") && !/^--zb-(?:gray-|indigo-|ink$)/.test(name))
      tokens[name] = style.getPropertyValue(name).trim();
  return {
    scheme: root.dataset.theme === "light" ? "light" : "dark",
    tokens,
    fontSans: style.getPropertyValue("--zb-font-sans").trim(),
    fontMono: style.getPropertyValue("--zb-font-mono").trim(),
    fontScale: Number(style.getPropertyValue("--zb-font-scale")) || 1,
  };
}
