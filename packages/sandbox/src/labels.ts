import { SandboxError } from "./interface.js";

/** Discovery must always be explicitly scoped. Labels contain identifiers, never credentials. */
export function lookupLabels(input: Readonly<Record<string, string>>) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new SandboxError("invalid", "Invalid lookup labels");
  const entries = Object.entries(input);
  if (
    !entries.length ||
    entries.length > 16 ||
    entries.some(
      ([key, value]) =>
        !/^[A-Za-z0-9_.-]{1,64}$/.test(key) ||
        typeof value !== "string" ||
        !value ||
        value.length > 200 ||
        /[\0\r\n]/.test(value),
    )
  )
    throw new SandboxError("invalid", "Invalid lookup labels");
  return Object.fromEntries(entries);
}
export const matchesLabels = (wanted: Record<string, string>, actual: unknown) =>
  !!actual &&
  typeof actual === "object" &&
  !Array.isArray(actual) &&
  Object.entries(wanted).every(
    ([key, value]) =>
      Object.hasOwn(actual, key) && (actual as Record<string, unknown>)[key] === value,
  );
