import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ignored = new Set([
  ".git",
  ".playwright-cli",
  "cloud",
  ".claude",
  ".codex",
  ".agents",
  "node_modules",
  ".cache",
  "dist",
  ".next",
  ".vercel",
  "coverage",
  "test-results",
  "output",
  "playwright-report",
  ".expo",
]);
// Generated native projects (Expo prebuild) are not source.
const ignoredPaths = new Set(["apps/mobile/ios", "apps/mobile/android"]);
const ownedRoots = new Set([
  "apps",
  "packages",
  "tools",
  "tests",
  "e2e",
  "fixtures",
  "scripts",
  "docs",
  ".github",
]);
const policies = {
  core: ["protocol"],
  store: ["core", "protocol"],
  ui: ["protocol"],
  "adapters/sdk": ["protocol"],
  "adapters/claude": ["adapters/sdk", "protocol"],
  "adapters/codex": ["adapters/sdk", "protocol"],
  "adapters/acp": ["adapters/sdk", "protocol"],
  "adapters/pi": ["adapters/sdk", "protocol"],
  sandbox: [],
};

function owner(file) {
  const parts = file.split("/");
  if (parts[0] !== "packages") return undefined;
  return parts[1] === "adapters" ? `adapters/${parts[2]}` : parts[1];
}

function dependency(file, specifier) {
  if (specifier.startsWith("."))
    return owner(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
  if (specifier.startsWith("@zoltbot/"))
    return specifier
      .slice(9)
      .split("/")[0]
      .replace(/^adapters-/, "adapters/");
  return undefined;
}

export function sourceViolations(file, text, backlog) {
  const errors = [];
  const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  if (lines > 800 && !file.endsWith("pnpm-lock.yaml") && !file.endsWith("package-lock.json"))
    errors.push(`${file}: ${lines} lines exceeds 800`);
  if (/\.(?:[cm]?[jt]sx?|md)$/.test(file)) {
    for (const [i, line] of text.split("\n").entries()) {
      if (/^\s*(?:\/\/|\/\*|\*|#|<!--)?\s*TODO\b/.test(line)) {
        const refs = line.match(/BL-\d+/g) ?? [];
        if (!refs.some((ref) => backlog.includes(ref)))
          errors.push(`${file}:${i + 1}: TODO needs an existing BL reference`);
      }
    }
  }
  if (!/\.[cm]?[jt]sx?$/.test(file)) return errors;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const current = owner(file);
  const allowed = policies[current];
  function check(specifier) {
    const target = dependency(file, specifier);
    if (
      allowed &&
      ((target && target !== current && !allowed.includes(target)) ||
        (current === "core" &&
          !target &&
          !specifier.startsWith(".") &&
          !(file.endsWith(".test.ts") && specifier === "vitest")))
    ) {
      errors.push(`${file}: forbidden import ${specifier} from ${current}`);
    }
  }
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === "require")
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) check(arg.text);
      else if (allowed) errors.push(`${file}: nonliteral dynamic imports cannot be checked`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

// Stylesheets that must read design tokens instead of literal values. The token files
// themselves define the literal values and are outside these component scopes.
const tokenScopes = [/^packages\/ui\/src\/.+\.css$/];
const tokenExempt = new Set();
const scaled = /^\s*(font-size|line-height|border-radius|font-weight)\s*:\s*([^;]+);/;
const keywords = /^(?:var\(--zb-[^)]+\)|inherit|normal|0|1|50%|100%)$/;

export function tokenFindings(file, text) {
  if (!tokenScopes.some((scope) => scope.test(file)) || tokenExempt.has(file)) return [];
  const findings = [];
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).split("\n");
  const raw = text.split("\n");
  for (const [i, line] of lines.entries()) {
    // A deliberate exception, such as a marketing effect, says so on its own line.
    if (raw[i]?.includes("tokens: allow")) continue;
    const at = `${file}:${i + 1}`;
    if (/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\(/.test(line)) findings.push(`${at}: literal color`);
    if (/\b(?:linear|radial|conic)-gradient\(|backdrop-filter\s*:/.test(line))
      findings.push(`${at}: gradient or backdrop filter`);
    const match = scaled.exec(line);
    if (match && !keywords.test(match[2].trim()))
      findings.push(`${at}: ${match[1]} is not a token`);
  }
  return findings;
}

async function sourceFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (dir === root && entry.isDirectory() && !ownedRoots.has(entry.name)) continue;
      if (ignoredPaths.has(path.relative(root, absolute).split(path.sep).join("/"))) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|md|json|css|html|ya?ml|sql)$/.test(entry.name))
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return files;
}

export async function quality(root = process.cwd()) {
  const backlog = await readFile(path.join(root, "docs/backlog.md"), "utf8").catch(() => "");
  const errors = [];
  const tokens = [];
  for (const file of await sourceFiles(root)) {
    const text = await readFile(path.join(root, file), "utf8");
    errors.push(...sourceViolations(file, text, backlog));
    tokens.push(...tokenFindings(file, text));
  }
  return { errors, tokens };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, tokens } = await quality(process.argv.slice(2).find((a) => !a.startsWith("--")));
  // Every stylesheet value comes from --zb tokens; a deliberate exception says `tokens: allow`.
  if (tokens.length)
    errors.push(...tokens, `Design tokens: ${tokens.length} untokenized values in stylesheets.`);
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else
    process.stdout.write(
      "Quality gates passed: boundaries, line counts, backlog references, tokens.\n",
    );
}
