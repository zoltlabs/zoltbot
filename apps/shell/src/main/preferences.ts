import { readFile, rename, writeFile } from "node:fs/promises";
import {
  normalizePreferences,
  type Preferences,
  parsePreferencesPatch,
} from "../shared/preferences";

const STORE_VERSION = 1;

interface StoredPreferences {
  version: number;
  values: unknown;
}

export async function readPreferences(path: string): Promise<Preferences> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredPreferences>;
    return normalizePreferences(migrate(parsed));
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return normalizePreferences({});
    throw error;
  }
}

/** Applies a validated partial update, writes it atomically and returns the full result. */
export async function updatePreferences(path: string, patch: unknown): Promise<Preferences> {
  const changes = parsePreferencesPatch(patch);
  const next = normalizePreferences({ ...(await readPreferences(path)), ...changes });
  const stored: StoredPreferences = { version: STORE_VERSION, values: next };
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  return next;
}

/**
 * Brings an older file up to the current shape. Version 1 is the first, so
 * there is nothing to migrate yet. Keys added later are filled from the
 * defaults by `normalizePreferences`. A file from a newer app keeps the values
 * this version understands.
 */
function migrate(stored: Partial<StoredPreferences>): unknown {
  if (typeof stored.version !== "number") return {};
  return stored.values;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
