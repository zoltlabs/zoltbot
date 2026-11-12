import { readFile } from "node:fs/promises";
import { Template } from "e2b";
import { expect, it } from "vitest";

it("converts the base worker Dockerfile through the pinned E2B SDK without an account or build", async () => {
  const dockerfile = await readFile(
    new URL("../../../templates/sandbox/Dockerfile", import.meta.url),
    "utf8",
  );
  const template = Template({ fileContextPath: process.cwd() }).fromDockerfile(dockerfile);
  const definition = await Template.toJSON(template, false);
  expect(definition).toContain("ubuntu:24.04");
  expect(definition).toContain("/usr/local/bin/zolt-worker");
  expect(definition).toContain("pnpm build:worker");
  for (const [provider, name] of [
    ["claude", "@anthropic-ai/claude-code"],
    ["codex", "@openai/codex"],
  ] as const) {
    const pinned = JSON.parse(
      await readFile(
        new URL(`../../adapters/${provider}/definitions/${provider}.json`, import.meta.url),
        "utf8",
      ),
    ) as { testedVersions: string };
    expect(dockerfile).toContain(`${name}@${pinned.testedVersions}`);
  }
});
