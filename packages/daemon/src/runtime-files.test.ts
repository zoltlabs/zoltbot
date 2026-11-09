import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { RuntimeFiles } from "./runtime-files.js";

it("creates isolated private native configuration and extension files with idempotent cleanup", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/runtime-files-"));
  const files = new RuntimeFiles(root);
  try {
    const content = { hostMcp: { token: "synthetic-native-token" } };
    const first = await files.config(content);
    const second = await files.config(content);
    expect(first.path).not.toBe(second.path);
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual(content);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(first.path)).mode & 0o777).toBe(0o700);
    const source = "export default function extension() {}";
    const extension = await files.extension(
      source,
      createHash("sha256").update(source).digest("hex"),
    );
    expect(extension.path).toMatch(/\.ts$/);
    expect(readFileSync(extension.path, "utf8")).toBe(source);
    await first.dispose();
    await first.dispose();
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(true);
    await files.close();
    expect(existsSync(second.path)).toBe(false);
    expect(existsSync(extension.path)).toBe(false);
    await expect(files.config({})).rejects.toThrow("runtime_files_closed");
    await files.close();
  } finally {
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects invalid or oversized artifacts before creating any file", async () => {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/runtime-files-invalid-"));
  const files = new RuntimeFiles(root);
  try {
    await expect(files.extension("synthetic", "0".repeat(64))).rejects.toThrow(
      "extension_hash_mismatch",
    );
    await expect(files.config({ text: "x".repeat(1048577) })).rejects.toThrow(
      "runtime_file_too_large",
    );
    await expect(files.config(undefined)).rejects.toThrow("invalid_runtime_config");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(files.config(circular)).rejects.toThrow("invalid_runtime_config");
    expect(readdirSync(root)).toEqual([]);
  } finally {
    await files.close();
    rmSync(root, { recursive: true, force: true });
  }
});
