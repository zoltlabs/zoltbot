// Turns packages/tokens/tokens.css, with the desktop appearances in desktop.css on top, into plain
// values for React Native. Dark is the base block, light overlays it, and every var() is resolved
// within its own theme. Layers follow the CSS cascade: the light selectors outrank every :root, so
// light is shared root, desktop root, shared light, then desktop light. Values React Native cannot
// use (shadows, font stacks, clamp, easing) are left out; px and ms become numbers.

export type TokenValue = string | number;
export type TokenSet = Record<string, TokenValue>;

const block = (css: string, selector: string) => {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`The tokens have no ${selector} block`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
};

function declarations(body: string) {
  const out = new Map<string, string>();
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of clean.matchAll(/--zb-([\w-]+)\s*:\s*([^;]+);/g))
    out.set(match[1] as string, (match[2] as string).replace(/\s+/g, " ").trim());
  return out;
}

function resolve(raw: Map<string, string>) {
  const done = new Map<string, string>();
  const value = (name: string, seen: Set<string>): string => {
    const cached = done.get(name);
    if (cached !== undefined) return cached;
    if (seen.has(name)) throw new Error(`tokens.css has a var() loop at --zb-${name}`);
    const text = raw.get(name);
    if (text === undefined) throw new Error(`tokens.css uses an unknown token --zb-${name}`);
    const next = new Set(seen).add(name);
    const result = text.replace(/var\(--zb-([\w-]+)\)/g, (_, inner: string) => value(inner, next));
    done.set(name, result);
    return result;
  };
  for (const name of raw.keys()) value(name, new Set());
  return done;
}

function convert(text: string): TokenValue | undefined {
  if (/^#[0-9a-fA-F]{3,8}$/.test(text)) return text.toLowerCase();
  if (/^rgba?\([\d.,\s]+\)$/.test(text)) return text.replace(/\s*,\s*/g, ", ");
  const unit = /^(-?\d+(?:\.\d+)?)(px|ms)?$/.exec(text);
  if (unit) return Number(unit[1]);
  return undefined;
}

function values(resolved: Map<string, string>): TokenSet {
  const out: TokenSet = {};
  for (const [name, text] of resolved) {
    // The ink triple only feeds rgba() above; on its own it is not a color.
    if (name === "ink") continue;
    const converted = convert(text);
    if (converted !== undefined) out[name] = converted;
  }
  return out;
}

export function buildTheme(css: string, desktopCss = ""): { dark: TokenSet; light: TokenSet } {
  const light = ':root[data-theme="light"]';
  const layer = (source: string, selector: string) =>
    source ? declarations(block(`\n${source}`, selector)) : new Map<string, string>();
  const dark = new Map([...declarations(block(css, ":root")), ...layer(desktopCss, ":root")]);
  const lights = [declarations(block(css, light)), layer(desktopCss, light)];
  for (const overlay of lights)
    for (const name of overlay.keys())
      if (!dark.has(name)) throw new Error(`Light declares --zb-${name}, which dark does not`);
  return {
    dark: values(resolve(dark)),
    light: values(resolve(new Map([...dark, ...lights.flatMap((overlay) => [...overlay])]))),
  };
}

export function themeSource(theme: { dark: TokenSet; light: TokenSet }): string {
  const fields = Object.entries(theme.dark)
    .map(([name, value]) => `  ${JSON.stringify(name)}: ${typeof value};`)
    .join("\n");
  return [
    "// Generated from packages/tokens/tokens.css and desktop.css by `pnpm theme:mobile`. Do not edit.",
    "// A test fails when this file and the token files disagree.",
    "",
    "export interface Tokens {",
    fields,
    "}",
    `export const dark: Tokens = ${JSON.stringify(theme.dark, null, 2)};`,
    `export const light: Tokens = ${JSON.stringify(theme.light, null, 2)};`,
    "",
  ].join("\n");
}
