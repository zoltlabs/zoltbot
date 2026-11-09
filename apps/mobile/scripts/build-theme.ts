import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTheme, themeSource } from "../src/theme/generate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tokens = (name: string) => readFileSync(path.join(root, "packages/tokens", name), "utf8");
const target = path.join(root, "apps/mobile/src/theme/tokens.generated.ts");
writeFileSync(target, themeSource(buildTheme(tokens("tokens.css"), tokens("desktop.css"))));
execFileSync("pnpm", ["exec", "biome", "format", "--write", target], {
  cwd: root,
  stdio: "ignore",
});
process.stdout.write(`Wrote ${path.relative(root, target)}\n`);
