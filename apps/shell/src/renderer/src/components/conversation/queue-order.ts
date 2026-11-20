/** `ids` with `id` moved to index `to`, or null when that changes nothing or is out of range. */
export function moved(ids: readonly string[], id: string, to: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0 || to < 0 || to >= ids.length || to === from) return null;
  const next = ids.filter((other) => other !== id);
  next.splice(to, 0, id);
  return next;
}
