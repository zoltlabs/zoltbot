import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { manifestRuntimeFile } from "./connections-runtime-file.js";

it("re-materializes one private manifest path after crash and rejects linked targets", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/connection-files-"));
  try {
    const first = manifestRuntimeFile(root, "a".repeat(64), "private-old");
    const restored = manifestRuntimeFile(root, "a".repeat(64), "private-current");
    expect(restored.path).toBe(first.path);
    expect(readFileSync(restored.path, "utf8")).toBe("private-current");
    expect(statSync(restored.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(restored.path)).mode & 0o777).toBe(0o700);
    await restored.dispose();
    mkdirSync(path.dirname(restored.path));
    symlinkSync(path.join(root, "outside"), restored.path);
    expect(() => manifestRuntimeFile(root, "a".repeat(64), "private-new")).toThrow(
      "runtime_config_unsafe",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
