const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;

/**
 * Normalizes a rewind_files response: {canRewind, error?, filesChanged?, insertions?, deletions?}
 * as Claude 2.1.42 defines it. Unknown fields are ignored; a malformed answer cannot rewind.
 */
export function rewindResult(value: Record<string, unknown>) {
  const files = Array.isArray(value.filesChanged)
    ? value.filesChanged.filter((file): file is string => typeof file === "string").slice(0, 1000)
    : [];
  const insertions = count(value.insertions),
    deletions = count(value.deletions);
  const error =
    typeof value.error === "string" && value.error ? value.error.slice(0, 500) : undefined;
  return {
    canRewind: value.canRewind === true,
    files,
    ...(insertions !== undefined ? { insertions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    ...(error ? { error } : value.canRewind === true ? {} : { error: "rewind_unavailable" }),
  };
}
