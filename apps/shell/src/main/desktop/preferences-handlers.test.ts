import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, PREFERENCE_CHANNELS } from "../../shared/preferences";
import { readPreferences, updatePreferences } from "../preferences";
import { preferenceHandlers } from "./preferences-handlers";

function fileHandlers() {
  const path = join(mkdtempSync(join(tmpdir(), "zoltbot-preferences-")), "preferences.json");
  const onChange = vi.fn();
  const handlers = preferenceHandlers(
    { read: () => readPreferences(path), update: (patch) => updatePreferences(path, patch) },
    onChange,
  );
  return {
    get: handlers[PREFERENCE_CHANNELS.preferencesGet] as () => Promise<unknown>,
    set: handlers[PREFERENCE_CHANNELS.preferencesSet] as (patch: unknown) => Promise<unknown>,
    onChange,
  };
}

describe("preference handlers", () => {
  it("reads defaults, saves a change and announces it", async () => {
    const { get, set, onChange } = fileHandlers();
    expect(await get()).toEqual(DEFAULT_PREFERENCES);
    const saved = await set({ theme: "dark" });
    expect(saved).toMatchObject({ theme: "dark", sounds: true });
    expect(onChange).toHaveBeenCalledWith(saved);
    expect(await get()).toEqual(saved);
  });

  it("applies quick changes in order without losing one", async () => {
    const { get, set } = fileHandlers();
    await Promise.all([
      set({ theme: "light" }),
      set({ sounds: false }),
      set({ textSize: "large" }),
    ]);
    expect(await get()).toMatchObject({ theme: "light", sounds: false, textSize: "large" });
  });

  it("rejects an invalid change, announces nothing and keeps working", async () => {
    const { get, set, onChange } = fileHandlers();
    await expect(set({ theme: "purple" })).rejects.toThrow(/theme/);
    expect(onChange).not.toHaveBeenCalled();
    await set({ showInDock: false });
    expect(await get()).toMatchObject({ showInDock: false, theme: "system" });
  });
});
