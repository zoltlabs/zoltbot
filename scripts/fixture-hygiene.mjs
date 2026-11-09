import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export function fixtureIssues(text) {
  const issues = [];
  if (/\/Users\/[^/\s"']+|\/home\/(?!user\b)[^/\s"']+/.test(text))
    issues.push("personal home path");
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) issues.push("email address");
  if (
    /\bsk-[A-Za-z0-9_-]{12,}\b|Bearer\s+(?!\[redacted\]|<redacted>)[A-Za-z0-9._-]{12,}/i.test(text)
  )
    issues.push("credential pattern");
  if (
    /"(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token)"\s*:\s*"(?!\[redacted\]|<redacted>|\[secret\])[^"\s]+"/i.test(
      text,
    )
  )
    issues.push("unredacted credential field");
  return issues;
}
export async function checkFixtures(root) {
  const errors = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:jsonl?|ya?ml)$/.test(file))
        for (const issue of fixtureIssues(await readFile(file, "utf8")))
          errors.push(`${file}: ${issue}`);
    }
  }
  await walk(root);
  return errors;
}
if (process.argv[1]?.endsWith("fixture-hygiene.mjs")) {
  const errors = await checkFixtures(process.argv[2] ?? "fixtures");
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("Fixture hygiene passed.\n");
}
