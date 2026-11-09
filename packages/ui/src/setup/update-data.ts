export interface UpdateView {
  definitionId: string;
  displayName: string;
  installed: string;
  latest: string;
  command: string[];
}
/** Keeps only well formed rows from `update.list`. */
export function updateRows(value: unknown): UpdateView[] {
  const rows =
    value && typeof value === "object" ? (value as { updates?: unknown }).updates : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is UpdateView =>
      !!row &&
      typeof row === "object" &&
      ["definitionId", "displayName", "installed", "latest"].every(
        (key) => typeof (row as Record<string, unknown>)[key] === "string",
      ) &&
      Array.isArray((row as Record<string, unknown>).command) &&
      ((row as Record<string, unknown>).command as unknown[]).every(
        (part) => typeof part === "string",
      ),
  );
}
/** A dismissed version stays hidden; the next release shows the card again. */
export function visibleUpdates(rows: UpdateView[], dismissed: unknown) {
  const hidden =
    dismissed && typeof dismissed === "object" ? (dismissed as Record<string, unknown>) : {};
  return rows.filter((row) => hidden[row.definitionId] !== row.latest);
}
