// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../shared/preferences";
import { readPreferences, updatePreferences } from "./preferences";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zoltbot-preferences-"));
  roots.push(root);
  return join(root, "preferences.json");
}

describe("preferences store", () => {
  it("returns the defaults when the file is missing or unreadable", async () => {
    const path = await storePath();
    await expect(readPreferences(path)).resolves.toEqual(DEFAULT_PREFERENCES);
    await writeFile(path, "{not json");
    await expect(readPreferences(path)).resolves.toEqual(DEFAULT_PREFERENCES);
  });

  it("round-trips an update and keeps the other values", async () => {
    const path = await storePath();
    await updatePreferences(path, { theme: "dark", keyBindings: { "tasks.open": "Mod+Shift+T" } });
    const next = await updatePreferences(path, { sounds: false });
    expect(next).toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "dark",
      sounds: false,
      keyBindings: { "tasks.open": "Mod+Shift+T" },
    });
    await expect(readPreferences(path)).resolves.toEqual(next);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  it("fills keys added after the file was written from the defaults", async () => {
    const path = await storePath();
    await writeFile(path, JSON.stringify({ version: 1, values: { theme: "light" } }));
    await expect(readPreferences(path)).resolves.toEqual({
      ...DEFAULT_PREFERENCES,
      theme: "light",
    });
  });

  it("falls back to the default for an invalid stored value", async () => {
    const path = await storePath();
    await writeFile(
      path,
      JSON.stringify({ version: 1, values: { theme: "sepia", textSize: "large", sounds: "yes" } }),
    );
    await expect(readPreferences(path)).resolves.toEqual({
      ...DEFAULT_PREFERENCES,
      textSize: "large",
    });
  });

  it("rejects an unknown key or an invalid value in an update without writing", async () => {
    const path = await storePath();
    await expect(updatePreferences(path, { volume: 3 })).rejects.toThrow("Unknown preference");
    await expect(updatePreferences(path, { theme: "sepia" })).rejects.toThrow("Invalid value");
    await expect(updatePreferences(path, { keyBindings: { "": "Mod+K" } })).rejects.toThrow(
      "Invalid value",
    );
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });
});
