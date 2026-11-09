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
