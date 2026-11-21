// M6: a line diff between a skill's SKILL.md and an agent's proposed text. Pure, so it's tested
// without a renderer.

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };
/** A run of unchanged lines folded away. */
export type DiffSkip = { kind: "skip"; count: number };

/** Above this many line pairs the diff shows every old line removed and every new line added. */
const MAX_CELLS = 4_000_000;

const lines = (text: string) => {
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows;
};

/** The shortest edit from `before` to `after`, line by line (longest common subsequence). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before),
    b = lines(after);
  // Common lines at either end need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const head = a.slice(0, start).map((text): DiffLine => ({ kind: "same", text }));
  const tail = a.slice(a.length - end).map((text): DiffLine => ({ kind: "same", text }));
  const x = a.slice(start, a.length - end),
    y = b.slice(start, b.length - end);
  const removed = (text: string): DiffLine => ({ kind: "removed", text });
  const added = (text: string): DiffLine => ({ kind: "added", text });
  if (x.length * y.length > MAX_CELLS)
    return [...head, ...x.map(removed), ...y.map(added), ...tail];
  const width = y.length + 1;
  const table = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      table[i * width + j] =
        x[i] === y[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
  const middle: DiffLine[] = [];
  let i = 0,
    j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      middle.push({ kind: "same", text: x[i] ?? "" });
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
      middle.push(removed(x[i++] ?? ""));
    else middle.push(added(y[j++] ?? ""));
  }
  while (i < x.length) middle.push(removed(x[i++] ?? ""));
  while (j < y.length) middle.push(added(y[j++] ?? ""));
  return [...head, ...middle, ...tail];
}

/** Keeps `context` unchanged lines around each change and folds longer unchanged runs. */
export function foldDiff(diff: DiffLine[], context = 2): (DiffLine | DiffSkip)[] {
  const near = diff.map(() => false);
  diff.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= index + context && k < diff.length; k++)
      near[k] = true;
  });
  const out: (DiffLine | DiffSkip)[] = [];
  let skipped: DiffLine[] = [];
  // A single hidden line takes as much room as its fold, so it shows instead.
  const flush = () => {
    if (skipped.length === 1) out.push(...skipped);
    else if (skipped.length) out.push({ kind: "skip", count: skipped.length });
    skipped = [];
  };
  diff.forEach((line, index) => {
    if (near[index]) {
      flush();
      out.push(line);
    } else skipped.push(line);
  });
  flush();
  return out;
}
