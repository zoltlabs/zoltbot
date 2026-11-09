import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { FlavorRegistry } from "./flavor.js";

it("loads a new flavor configuration without editing the generic client", async () => {
  const root = path.resolve(".cache/test-tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(path.join(root, "acp-flavor-"));
  try {
    const file = path.join(dir, "flavor.json");
    await writeFile(
      file,
      '{"id":"temp-provider","testedVersions":"test-1","mcpInjection":"session_new","instructionInjection":"refresh_every_n_prompts","refreshEvery":3}',
    );
    const registry = new FlavorRegistry();
    await registry.load(pathToFileURL(file).href);
    expect(registry.get("temp-provider").refreshEvery).toBe(3);
    expect(() => registry.register(registry.get("temp-provider"))).toThrow(
      "duplicate_or_invalid_flavor",
    );
    expect(() => registry.get("missing")).toThrow("unknown_acp_flavor");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
