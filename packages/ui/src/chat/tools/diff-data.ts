export interface FileDiff {
  path: string;
  before?: string;
  after?: string;
  patch?: string;
}
export type DiffLineKind = "add" | "del" | "ctx" | "hunk" | "meta";
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** Old and new line numbers where known. */
  old?: number;
  new?: number;
}

export function fileDiffs(value: unknown): FileDiff[] {
  if (!Array.isArray(value)) return [];
  const result: FileDiff[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const diff: FileDiff = { path: typeof row.path === "string" ? row.path : "" };
    for (const key of ["before", "after", "patch"] as const)
      if (typeof row[key] === "string") diff[key] = row[key] as string;
    if (diff.patch !== undefined || diff.before !== undefined || diff.after !== undefined)
      result.push(diff);
  }
  return result;
}

function patchLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0,
    newLine = 0;
  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "hunk", text: raw });
    } else if (/^(?:---|\+\+\+|diff |index |\\ No newline)/.test(raw))
      lines.push({ kind: "meta", text: raw });
    else if (raw.startsWith("+")) lines.push({ kind: "add", text: raw.slice(1), new: newLine++ });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: raw.slice(1), old: oldLine++ });
    else
      lines.push({
        kind: "ctx",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
        old: oldLine++,
        new: newLine++,
      });
  }
  return lines;
}

const split = (value: string) => (value === "" ? [] : value.replace(/\n$/, "").split("\n"));
/**
 * Line diff for before and after text. Small inputs use a longest common subsequence; very large
 * inputs fall back to a replace-all diff so rendering never blocks the timeline.
 */
export function lineDiff(before: string, after: string, budget = 400_000): DiffLine[] {
  const a = split(before),
    b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a
    .slice(0, start)
    .map((line, index) => ({ kind: "ctx", text: line, old: index + 1, new: index + 1 }));
  const tail: DiffLine[] = a.slice(endA).map((line, index) => ({
    kind: "ctx",
    text: line,
    old: endA + index + 1,
    new: endB + index + 1,
  }));
  const midA = a.slice(start, endA),
    midB = b.slice(start, endB);
  const middle: DiffLine[] = [];
  if (midA.length * midB.length > budget) {
    midA.forEach((line, index) => {
      middle.push({ kind: "del", text: line, old: start + index + 1 });
    });
    midB.forEach((line, index) => {
      middle.push({ kind: "add", text: line, new: start + index + 1 });
    });
  } else {
    const rows = midA.length + 1,
      cols = midB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i--)
      for (let j = midB.length - 1; j >= 0; j--)
        table[i * cols + j] =
          midA[i] === midB[j]
            ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    let i = 0,
      j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        middle.push({
          kind: "ctx",
          text: midA[i] ?? "",
          old: start + i + 1,
          new: start + j + 1,
        });
        i++;
        j++;
      } else if (
        j < midB.length &&
        (i >= midA.length || (table[i * cols + j + 1] ?? 0) > (table[(i + 1) * cols + j] ?? 0))
      ) {
        middle.push({ kind: "add", text: midB[j] ?? "", new: start + j + 1 });
        j++;
      } else {
        middle.push({ kind: "del", text: midA[i] ?? "", old: start + i + 1 });
        i++;
      }
    }
  }
  return [...head, ...middle, ...tail];
}

/** Keeps a few context lines around changes and marks the gaps, like a unified diff. */
export function trimContext(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.kind === "ctx") return;
    for (
      let at = Math.max(0, index - context);
      at <= Math.min(lines.length - 1, index + context);
      at++
    )
      keep[at] = 1;
  });
  const result: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) result.push({ kind: "hunk", text: `${skipped} unchanged lines` });
      skipped = 0;
      result.push(line);
    } else skipped++;
  });
  if (skipped && result.length) result.push({ kind: "hunk", text: `${skipped} unchanged lines` });
  return result;
}

export function diffLines(diff: FileDiff): DiffLine[] {
  if (diff.patch !== undefined) return patchLines(diff.patch);
  return trimContext(lineDiff(diff.before ?? "", diff.after ?? ""));
}
export function countLines(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    if (line.kind === "del") removed++;
  }
  return { added, removed };
}
export function diffStats(diffs: FileDiff[]): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const diff of diffs) {
    const counts = countLines(diffLines(diff));
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed };
}
