import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
const publicCloudDirectories = [
  "apps/mobile/src/cloud",
  "apps/mobile/src/ui/cloud",
  "apps/shell/src/renderer/src/components/cloud",
].map((directory) => path.join(root, directory) + path.sep);
const publicCloudModules = new Set(
  ["apps/mobile/src/state/cloud", "apps/shell/src/shared/cloud"].map((module) =>
    path.join(root, module),
  ),
);
// The relay is public; every other service stays in the private repository.
const forbidden =
  /(?:^|\/)(?:cloud|zoltbot-cloud|zoltbot\.ai)(?:\/|$)|(?:^|\/)services(?:\/(?!relay(?:\/|$))|$)|(?:^|\/)spikes\/do-cell(?:\/|$)/;
// Public clients call these account endpoints; they are not filesystem dependencies.
const publicAccountRoutes = new Set([
  "/api/cloud",
  "/api/cloud/",
  "/api/cloud/push",
  "/api/cloud/hooks",
  "/api/cloud/devices",
  "/api/cloud/cell-token",
  "/api/cloud/jwks.json",
  "/api/cloud/access",
  "/api/cloud/sandboxes",
  "/api/cloud/sandboxes/wake",
  "/api/cloud/sandboxes/sleep",
  "/api/cloud/usage",
  "/api/cloud/github/pull-request",
  "/api/cloud/secrets/github",
  "/api/cloud/secrets/anthropic",
  "/api/cloud/secrets/openai",
  "/api/cloud/runner-grants",
  "/api/cloud/runner-token",
  "/api/cloud/worker-token",
]);
const errors = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        ".claude",
        ".codex",
        ".agents",
        ".playwright-cli",
        "test-results",
        "playwright-report",
        ".git",
        ".cache",
        "output",
        "dist",
      ].includes(entry.name) ||
      (directory === root &&
        ["cloud", "zoltbot-cloud", "zoltbot.ai", "spikes"].includes(entry.name))
    )
      continue;
    const file = path.join(directory, entry.name);
    if (file === path.join(root, "apps/shell/out")) continue;
    if (entry.isDirectory()) await walk(file);
    else if (/\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(entry.name)) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (relative === "scripts/public-boundary.mjs" || relative.startsWith("scripts/split/"))
        continue;
      const text = await readFile(file, "utf8");
      if (relative.startsWith("packages/cell/src/") && !relative.endsWith(".test.ts")) {
        for (const match of text.matchAll(
          /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g,
        )) {
          const specifier = match[1];
          if (
            /^(?:node:|@zoltbot\/(?:daemon|adapters)(?:\/|$)|better-sqlite3$)/.test(specifier) ||
            /(?:^|\/)daemon(?:\/|$)/.test(specifier) ||
            [
              "fs",
              "path",
              "os",
              "child_process",
              "net",
              "tls",
              "http",
              "https",
              "worker_threads",
              "crypto",
            ].includes(specifier)
          )
            errors.push(`${relative}: Node-only cell import ${specifier}`);
        }
        if (/\.snapshot\s*\(/.test(text)) errors.push(`${relative}: unscoped cell snapshot`);
      }

      for (const match of text.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
        const value = match[1];
        const moduleReference =
          /\b(?:from\s*|import\s*(?:\(\s*)?|require(?:\.resolve)?\s*\(\s*)$/.test(
            text.slice(0, match.index),
          );
        // Routing enums and known HTTP routes grant no permission to import private modules.
        if (
          !moduleReference &&
          (value === "cloud" ||
            publicAccountRoutes.has(value) ||
            value.startsWith("/api/cloud/hooks/") ||
            (relative.endsWith(".test.ts") &&
              /^(GET|POST|DELETE) \/api\/cloud\/hooks(?:\/|$)/.test(value)))
        )
          continue;
        if (
          !moduleReference &&
          relative === "apps/mobile/src/cloud/account.test.ts" &&
          /^(?:POST \/api\/cloud\/devices|PUT \/api\/cloud\/push|DELETE \/api\/cloud\/push\/\$\{key\.deviceId\})$/.test(
            value,
          )
        )
          continue;
        if (
          !moduleReference &&
          relative === "apps/shell/src/renderer/src/i18n/jsx-text-baseline.json" &&
          /^components\/cloud\/[A-Za-z]+\.tsx$/.test(value)
        )
          continue;
        if (/^https?:\/\//.test(value) || value.startsWith(".cache/spikes/")) continue;
        if (moduleReference && value.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), value);
          if (
            publicCloudModules.has(resolved.replace(/\.[cm]?[jt]sx?$/, "")) ||
            publicCloudDirectories.some((directory) => resolved.startsWith(directory))
          )
            continue;
        }
        if (forbidden.test(value) && !value.startsWith("!"))
          errors.push(`${relative}: private reference ${value}`);
      }
    }
  }
}
await walk(root);
if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exitCode = 1;
} else process.stdout.write("Public dependency boundary passed\n");
