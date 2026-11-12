import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");
// The relay is public; every other service stays in the private repository.
const forbidden =
  /(?:^|\/)(?:cloud|zoltbot\.ai)(?:\/|$)|(?:^|\/)services(?:\/(?!relay(?:\/|$))|$)|(?:^|\/)spikes\/do-cell(?:\/|$)/;
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
        "cloud",
        "zoltbot.ai",
        "spikes",
      ].includes(entry.name)
    )
      continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (/\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(entry.name)) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (relative === "scripts/public-boundary.mjs" || relative.startsWith("scripts/split/"))
        continue;
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
        const value = match[1];
        // "cloud" is also a public routing enum. A bare module import still violates the boundary.
        if (
          value === "cloud" &&
          !/\b(?:from|import|require(?:\.resolve)?)\s*(?:\(\s*)?$/.test(text.slice(0, match.index))
        )
          continue;
        if (/^https?:\/\//.test(value) || value.startsWith(".cache/spikes/")) continue;
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
