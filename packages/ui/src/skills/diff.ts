/** Accessible plain-text diff. Linear work, bounded by parser limits. */
export function skillVersionDiff(before: string, after: string) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  if (start === a.length && start === b.length) return "No instruction changes.";
  return [
    ...a.slice(Math.max(0, start - 2), start).map((line) => `unchanged: ${line}`),
    ...a.slice(start, a.length - end).map((line) => `removed: ${line}`),
    ...b.slice(start, b.length - end).map((line) => `added: ${line}`),
    ...b.slice(b.length - end, b.length - end + 2).map((line) => `unchanged: ${line}`),
  ].join("\n");
}
