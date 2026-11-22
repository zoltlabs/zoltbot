/**
 * A word-level diff for prose. Lines are matched first, so a moved paragraph stays one change,
 * then each changed run of lines is compared word by word. Every change carries its offsets in
 * both texts, so it can be accepted (the baseline takes the new words) or rejected (the current
 * text takes the old words back) on its own.
 */

export interface ProseChange {
  /** Stable while the texts don't change: the change's position in both texts. */
  id: string;
  baseFrom: number;
  baseTo: number;
  currentFrom: number;
  currentTo: number;
  removed: string;
  added: string;
}

export type ProseSegment =
  | { type: "equal"; text: string }
  | { type: "change"; change: ProseChange };

export interface ProseDiff {
  segments: ProseSegment[];
  changes: ProseChange[];
}

type Op = { kind: "equal" | "delete" | "insert"; count: number };

/** Above this many edits, a block counts as one change instead of a word-by-word diff. */
const MAX_EDITS = 3000;

export function proseDiff(base: string, current: string): ProseDiff {
  const baseLines = splitLines(base);
  const currentLines = splitLines(current);
  const ops = diffSequences(baseLines, currentLines);
  const segments: ProseSegment[] = [];
  const changes: ProseChange[] = [];
  let baseIndex = 0;
  let currentIndex = 0;
  let baseOffset = 0;
  let currentOffset = 0;
  const equal = (text: string) => {
    if (!text) return;
    const last = segments.at(-1);
    if (last?.type === "equal") last.text += text;
    else segments.push({ type: "equal", text });
  };
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index] as Op;
    if (op.kind === "equal") {
      const text = baseLines.slice(baseIndex, baseIndex + op.count).join("");
      equal(text);
      baseIndex += op.count;
      currentIndex += op.count;
      baseOffset += text.length;
      currentOffset += text.length;
      continue;
    }
    // A run of deletes and inserts between two equal runs is one replaced block.
    let deleted = 0;
    let inserted = 0;
    for (let next = ops[index]; next && next.kind !== "equal"; next = ops[++index]) {
      if (next.kind === "delete") deleted += next.count;
      else inserted += next.count;
    }
    index--;
    const removedText = baseLines.slice(baseIndex, baseIndex + deleted).join("");
    const addedText = currentLines.slice(currentIndex, currentIndex + inserted).join("");
    for (const part of wordChanges(removedText, addedText)) {
      if (part.type === "equal") equal(part.text);
      else {
        const change: ProseChange = {
          id: `${baseOffset + part.baseFrom}:${currentOffset + part.currentFrom}`,
          baseFrom: baseOffset + part.baseFrom,
          baseTo: baseOffset + part.baseTo,
          currentFrom: currentOffset + part.currentFrom,
          currentTo: currentOffset + part.currentTo,
          removed: part.removed,
          added: part.added,
        };
        changes.push(change);
        segments.push({ type: "change", change });
      }
    }
    baseIndex += deleted;
    currentIndex += inserted;
    baseOffset += removedText.length;
    currentOffset += addedText.length;
  }
  return { segments, changes };
}

/** The baseline once `change` is accepted: it takes the change's new words. */
export function acceptChange(base: string, change: ProseChange): string {
  return base.slice(0, change.baseFrom) + change.added + base.slice(change.baseTo);
}

/** The current text once `change` is rejected: it takes the change's old words back. */
export function rejectChange(current: string, change: ProseChange): string {
  return current.slice(0, change.currentFrom) + change.removed + current.slice(change.currentTo);
}

/** A short description of a change for screen readers and the review bar. */
export function describeChange(change: ProseChange): string {
  const clip = (value: string) => {
    const words = value.replace(/\s+/g, " ").trim();
    return words.length > 60 ? `${words.slice(0, 57)}…` : words;
  };
  const removed = clip(change.removed);
  const added = clip(change.added);
  if (!removed && !added) return "Changed spacing";
  if (!removed) return `Added “${added}”`;
  if (!added) return `Removed “${removed}”`;
  return `Replaced “${removed}” with “${added}”`;
}

type WordPart =
  | { type: "equal"; text: string }
  | {
      type: "change";
      baseFrom: number;
      baseTo: number;
      currentFrom: number;
      currentTo: number;
      removed: string;
      added: string;
    };

function wordChanges(removed: string, added: string): WordPart[] {
  const left = tokens(removed);
  const right = tokens(added);
  const ops =
    left.length * right.length > 0 && left.length + right.length < 20_000
      ? diffSequences(left, right)
      : null;
  if (!ops)
    return [
      {
        type: "change",
        baseFrom: 0,
        baseTo: removed.length,
        currentFrom: 0,
        currentTo: added.length,
        removed,
        added,
      },
    ];
  const parts: WordPart[] = [];
  let l = 0;
  let r = 0;
  let lo = 0;
  let ro = 0;
  let pending: Extract<WordPart, { type: "change" }> | null = null;
  // A word or two left alone between two changes joins them, so a reworded phrase reads as one
  // change. The gap stays apart when the text after it is unchanged.
  let gap: { text: string; count: number } | null = null;
  const flushGap = () => {
    if (gap) parts.push({ type: "equal", text: gap.text });
    gap = null;
  };
  const flushPending = () => {
    if (pending) parts.push(pending);
    pending = null;
  };
  for (const op of ops) {
    if (op.kind === "equal") {
      const text = left.slice(l, l + op.count).join("");
      if (pending && shortGap(text)) {
        gap = { text, count: op.count };
      } else {
        flushPending();
        flushGap();
        parts.push({ type: "equal", text });
      }
      l += op.count;
      r += op.count;
      lo += text.length;
      ro += text.length;
      continue;
    }
    const text = (
      op.kind === "delete" ? left.slice(l, l + op.count) : right.slice(r, r + op.count)
    ).join("");
    if (pending && gap) {
      pending.removed += gap.text;
      pending.added += gap.text;
      pending.baseTo += gap.text.length;
      pending.currentTo += gap.text.length;
      gap = null;
    }
    if (!pending) {
      flushGap();
      pending = {
        type: "change",
        baseFrom: lo,
        baseTo: lo,
        currentFrom: ro,
        currentTo: ro,
        removed: "",
        added: "",
      };
    }
    if (op.kind === "delete") {
      pending.removed += text;
      pending.baseTo += text.length;
      l += op.count;
      lo += text.length;
    } else {
      pending.added += text;
      pending.currentTo += text.length;
      r += op.count;
      ro += text.length;
    }
  }
  flushPending();
  flushGap();
  return parts;
}

/** At most two words, on one line, without ending a sentence or clause. */
function shortGap(text: string): boolean {
  return (
    text.length <= 24 &&
    !/[\n.!?;:]/.test(text) &&
    (text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0) <= 2
  );
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function tokens(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}\p{M}'’_-]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/** Myers' diff of two sequences, as runs of equal, deleted and inserted items. */
export function diffSequences(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Op[] = [];
  const push = (kind: Op["kind"], count: number) => {
    if (count <= 0) return;
    const last = ops.at(-1);
    if (last?.kind === kind) last.count += count;
    else ops.push({ kind, count });
  };
  push("equal", start);
  const middle = myers(a.slice(start, endA), b.slice(start, endB));
  if (middle) for (const op of middle) push(op.kind, op.count);
  else {
    push("delete", endA - start);
    push("insert", endB - start);
  }
  push("equal", a.length - endA);
  return ops;
}

function myers(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return [
      ...(n ? [{ kind: "delete" as const, count: n }] : []),
      ...(m ? [{ kind: "insert" as const, count: m }] : []),
    ];
  }
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const left = v[offset + k - 1] ?? 0;
      const right = v[offset + k + 1] ?? 0;
      let x = k === -d || (k !== d && left < right) ? right : left + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a.length, b.length, offset, d);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, offset: number, depth: number) {
  const reversed: Op["kind"][] = [];
  let x = n;
  let y = m;
  for (let d = depth; d > 0; d--) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    const left = v[offset + k - 1] ?? 0;
    const right = v[offset + k + 1] ?? 0;
    const prevK = k === -d || (k !== d && left < right) ? k + 1 : k - 1;
    const prevX = v[offset + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push("equal");
      x--;
      y--;
    }
    reversed.push(x === prevX ? "insert" : "delete");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    reversed.push("equal");
    x--;
    y--;
  }
  const ops: Op[] = [];
  for (const kind of reversed.reverse()) {
    const last = ops.at(-1);
    if (last?.kind === kind) last.count++;
    else ops.push({ kind, count: 1 });
  }
  return ops;
}
