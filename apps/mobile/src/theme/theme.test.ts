import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTheme } from "./generate.js";
import { dark, light } from "./tokens.generated.js";

const tokens = (name: string) =>
  readFileSync(path.join(__dirname, "../../../../packages/tokens", name), "utf8");
const css = tokens("tokens.css");
const desktopCss = tokens("desktop.css");

describe("mobile theme", () => {
  it("matches tokens.css and desktop.css (run pnpm theme:mobile after changing tokens)", () => {
    const built = buildTheme(css, desktopCss);
    expect(dark).toEqual(built.dark);
    expect(light).toEqual(built.light);
  });
  it("uses the desktop Graphite and Parchment appearances, with resolved values", () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    expect(dark["bg-page"]).toBe("#1d1f21");
    expect(light["bg-page"]).toBe("#f7f4ed");
    expect(dark.accent).toBe("#b7cdbf");
    expect(light.accent).toBe("#725691");
    expect(light["bg-hover"]).toBe("rgba(63, 52, 69, 0.045)");
    expect(light.danger).toBe("#b02827");
    expect(dark["radius-lg"]).toBe(12);
    for (const value of Object.values(dark)) expect(String(value)).not.toContain("var(");
  });
  it("rejects a light token that dark does not declare", () => {
    const broken = css.replace(
      ':root[data-theme="light"] {',
      ':root[data-theme="light"] {\n  --zb-new: #fff;',
    );
    expect(() => buildTheme(broken)).toThrow("--zb-new");
  });
  it("lets shared light tokens outrank desktop root tokens, as the CSS cascade does", () => {
    const desktop = ':root {\n  --zb-ok: #010101;\n}\n:root[data-theme="light"] {\n}';
    const built = buildTheme(css, desktop);
    expect(built.dark.ok).toBe("#010101");
    expect(built.light.ok).toBe("#18794e");
  });
});

it("keeps mobile form boundaries and labels readable in both appearances", () => {
  const luminance = (hex: string) => {
    const channels =
      hex
        .slice(1)
        .match(/../g)
        ?.map((part) => {
          const value = Number.parseInt(part, 16) / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        }) ?? [];
    return channels.reduce((sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
  };
  const ratio = (a: string, b: string) => {
    const x = luminance(a),
      y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  for (const palette of [dark, light]) {
    for (const surface of ["bg-page", "bg-raised"] as const) {
      expect(ratio(palette["border-control"], palette[surface])).toBeGreaterThanOrEqual(3);
      for (const text of ["text", "text-secondary", "text-muted"] as const)
        expect(ratio(palette[text], palette[surface])).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(palette["text-on-primary"], palette.primary)).toBeGreaterThanOrEqual(4.5);
  }
});
