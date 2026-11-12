import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("allows public account route values while still rejecting private module imports", async () => {
  const cases = JSON.parse(await readFile(new URL("./cases.txt", import.meta.url), "utf8")) as {
    value: string;
    module: boolean;
    allowed: boolean;
  }[];
  const root = await mkdtemp(path.join(os.tmpdir(), "zoltbot-boundary-"));
  try {
    for (const fixture of cases) {
      await writeFile(
        path.join(root, "fixture.ts"),
        fixture.module
          ? `import ${JSON.stringify(fixture.value)};\n`
          : `const route = ${JSON.stringify(fixture.value)};\n`,
      );
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../../scripts/public-boundary.mjs", import.meta.url)), root],
        { encoding: "utf8" },
      );
      expect(result.status, JSON.stringify(fixture)).toBe(fixture.allowed ? 0 : 1);
      expect(result.error).toBeUndefined();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
