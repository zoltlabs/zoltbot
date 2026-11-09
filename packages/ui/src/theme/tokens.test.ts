import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../../tokens/tokens.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
function block(selector: RegExp, css = source) {
  const body = css.match(selector)?.[1] ?? "";
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] as string, m[2]?.trim()]),
  ) as Record<string, string>;
}
const dark = block(/^:root\s*\{([^}]+)\}/m);
const light = { ...dark, ...block(/^:root\[data-theme="light"\]\s*\{([^}]+)\}/m) };
function resolve(palette: Record<string, string>, value: string, depth = 0): string {
  if (depth > 8) throw new Error(`token cycle in ${value}`);
  return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) =>
    resolve(palette, palette[name] ?? "", depth + 1),
  );
}
type Color = [number, number, number, number];
function color(palette: Record<string, string>, name: string): Color {
  const text = resolve(palette, palette[name] ?? "");
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    return [...[0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)), 1] as Color;
  }
  const parts = text.match(/[\d.]+/g)?.map(Number) ?? [];
  if (parts.length < 3) throw new Error(`${name} is not a color: ${text}`);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1] as Color;
}
function over(front: Color, back: Color): Color {
  const a = front[3];
  return [0, 1, 2].map((i) => (front[i] ?? 0) * a + (back[i] ?? 0) * (1 - a)).concat(1) as Color;
}
function luminance(c: Color) {
  const [r, g, b] = c.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return (r ?? 0) * 0.2126 + (g ?? 0) * 0.7152 + (b ?? 0) * 0.0722;
}
function contrast(a: Color, b: Color) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

it("light changes values only and declares no new token", () => {
  const extra = Object.keys(block(/^:root\[data-theme="light"\]\s*\{([^}]+)\}/m)).filter(
    (name) => !(name in dark),
  );
  expect(extra).toEqual([]);
});

describe("v3 token contrast", () => {
  for (const [name, palette] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    const page = color(palette, "--zb-bg-page");
    const raised = color(palette, "--zb-bg-raised");
    for (const [ink, minimum] of [
      ["--zb-text", 15],
      ["--zb-text-secondary", 8],
      ["--zb-text-muted", 4.5],
    ] as const)
      it(`${name} ${ink} reaches ${minimum}:1 on page and raised surfaces`, () => {
        for (const surface of [page, raised])
          expect(contrast(over(color(palette, ink), surface), surface)).toBeGreaterThanOrEqual(
            minimum,
          );
      });
    for (const [ink, fill] of [
      ["--zb-ok", "--zb-ok-soft"],
      ["--zb-warn", "--zb-warn-soft"],
      ["--zb-danger", "--zb-danger-soft"],
      ["--zb-attention", "--zb-attention-soft"],
      ["--zb-accent-text", "--zb-accent-soft"],
      ["--zb-gate", "--zb-gate-soft"],
    ] as const)
      it(`${name} ${ink} reads at 4.5:1 on its chip fill`, () => {
        const chip = over(color(palette, fill), raised);
        expect(contrast(color(palette, ink), chip)).toBeGreaterThanOrEqual(4.5);
      });
    it(`${name} avatar initials read at 4.5:1 on every avatar hue`, () => {
      for (let hue = 1; hue <= 8; hue++)
        expect(
          contrast(color(palette, "--zb-text-on-accent"), color(palette, `--zb-avatar-${hue}`)),
        ).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name} muted text reads at 4.5:1 on hovered and active rows`, () => {
      for (const fill of ["--zb-bg-hover", "--zb-bg-active", "--zb-bg-selected"]) {
        const row = over(color(palette, fill), color(palette, "--zb-bg-popover"));
        expect(contrast(color(palette, "--zb-text-muted"), row)).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name} primary button text reads at 4.5:1 on the accent`, () => {
      for (const fill of ["--zb-accent", "--zb-accent-hover"])
        expect(
          contrast(color(palette, "--zb-text-on-accent"), color(palette, fill)),
        ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// App appearances override shared marketing tokens without changing avatar lettering.
const desktop = readFileSync(
  new URL("../../../tokens/desktop.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");
for (const [name, base] of [
  ["dark", dark],
  ["light", light],
] as const) {
  const palette = {
    ...base,
    ...block(/^:root\s*\{([^}]+)\}/m, desktop),
    ...(name === "light" ? block(/^:root\[data-theme="light"\]\s*\{([^}]+)\}/m, desktop) : {}),
  };
  describe(`desktop ${name} contrast`, () => {
    for (const surface of ["--zb-bg-page", "--zb-bg-raised", "--zb-bg-popover", "--zb-bg-canvas"]) {
      it(`text stays readable on ${surface}, including selected rows`, () => {
        const background = color(palette, surface);
        for (const fill of [background, over(color(palette, "--zb-bg-selected"), background)]) {
          for (const ink of [
            "--zb-text",
            "--zb-text-secondary",
            "--zb-text-muted",
            "--zb-text-dim",
          ])
            expect(contrast(color(palette, ink), fill)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrast(color(palette, "--zb-accent"), background)).toBeGreaterThanOrEqual(3);
      });
    }
    it("primary labels and keyboard hints remain readable in both states", () => {
      for (const fill of ["--zb-primary", "--zb-primary-hover"])
        expect(
          contrast(color(palette, "--zb-text-on-primary"), color(palette, fill)),
        ).toBeGreaterThanOrEqual(4.5);
    });
    it("status and accent chips keep readable labels", () => {
      for (const [ink, fill] of [
        ["--zb-ok", "--zb-ok-soft"],
        ["--zb-warn", "--zb-warn-soft"],
        ["--zb-danger", "--zb-danger-soft"],
        ["--zb-attention", "--zb-attention-soft"],
        ["--zb-accent-text", "--zb-accent-soft"],
        ["--zb-gate", "--zb-gate-soft"],
      ]) {
        const background = over(color(palette, fill as string), color(palette, "--zb-bg-raised"));
        expect(contrast(color(palette, ink as string), background)).toBeGreaterThanOrEqual(4.5);
      }
    });
    it("avatar letters retain their own white ink", () => {
      for (let hue = 1; hue <= 8; hue++)
        expect(
          contrast(color(palette, "--zb-text-on-accent"), color(palette, `--zb-avatar-${hue}`)),
        ).toBeGreaterThanOrEqual(4.5);
    });
  });
}

it("desktop theme overrides change colors only, never layout or typography", () => {
  const overrides = block(/^:root\[data-theme="light"\]\s*\{([^}]+)\}/m, desktop);
  for (const value of Object.values(overrides))
    expect(value).toMatch(/^(?:#[0-9a-f]{6}|rgba?\([^)]+\)|\d+, \d+, \d+)$/i);
});
