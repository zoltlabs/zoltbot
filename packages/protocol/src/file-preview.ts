// C16: which files the Mac and the phone can preview, by name, and the CSV/TSV reader both use.
// Kinds come from the file name only. Nothing here reads a file or trusts its contents.

export type FilePreviewKind =
  | "image"
  | "svg"
  | "pdf"
  | "text"
  | "csv"
  | "tsv"
  | "markdown"
  | "video"
  | "none";

const KINDS: Record<string, { kind: FilePreviewKind; mime: string }> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  svg: { kind: "svg", mime: "image/svg+xml" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  csv: { kind: "csv", mime: "text/csv" },
  tsv: { kind: "tsv", mime: "text/tab-separated-values" },
  md: { kind: "markdown", mime: "text/markdown" },
  markdown: { kind: "markdown", mime: "text/markdown" },
  mp4: { kind: "video", mime: "video/mp4" },
  m4v: { kind: "video", mime: "video/mp4" },
  webm: { kind: "video", mime: "video/webm" },
};

const TEXT = new Set(
  (
    "txt log json jsonl yaml yml toml ini xml html css js mjs cjs ts tsx jsx py rb go rs java kt " +
    "swift c h cc cpp hpp cs php sh zsh bash sql graphql proto lua r env diff patch"
  ).split(" "),
);

function extension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function filePreviewKind(name: string): FilePreviewKind {
  const ext = extension(name);
  return KINDS[ext]?.kind ?? (TEXT.has(ext) ? "text" : "none");
}

export function fileMimeType(name: string): string {
  const ext = extension(name);
  return KINDS[ext]?.mime ?? (TEXT.has(ext) ? "text/plain" : "application/octet-stream");
}

/** Images a provider accepts as a picture; everything else goes to the agent as a file. */
export function isProviderImage(name: string): boolean {
  return filePreviewKind(name) === "image";
}

/** Rows a preview shows. The rest is counted, not kept. */
export const DELIMITED_PREVIEW_ROWS = 500;
const MAX_COLUMNS = 200;
const MAX_CELL = 2000;

export interface DelimitedPreview {
  header: string[];
  rows: string[][];
  /** Data rows in the whole text, header excluded. */
  total: number;
}

/**
 * Reads CSV or TSV the way spreadsheets write it: quoted cells may hold the delimiter, line
 * breaks and doubled quotes. The first row is the header. Keeps `limit` data rows, trims very
 * long cells and very wide rows, and counts the rest.
 */
export function parseDelimited(
  input: string,
  delimiter: "," | "\t",
  limit = DELIMITED_PREVIEW_ROWS,
): DelimitedPreview {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let header: string[] | undefined;
  const rows: string[][] = [];
  let total = 0;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  // Whether the cell has had any character yet; `cell` stays empty past the limit.
  let fresh = true;
  const keep = () => header === undefined || rows.length < limit;
  const endCell = () => {
    if (keep() && row.length < MAX_COLUMNS) row.push(cell.slice(0, MAX_CELL));
    cell = "";
    fresh = true;
  };
  const endRow = () => {
    endCell();
    if (header === undefined) header = row;
    else {
      total++;
      if (rows.length < limit) rows.push(row);
    }
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char !== '"') {
        if (keep() && cell.length <= MAX_CELL) cell += char;
      } else if (text[i + 1] === '"') {
        if (keep() && cell.length <= MAX_CELL) cell += '"';
        i++;
      } else quoted = false;
      continue;
    }
    if (char === '"' && fresh) {
      quoted = true;
      started = true;
      fresh = false;
    } else if (char === delimiter) {
      endCell();
      started = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      if (started || cell || row.length) endRow();
    } else {
      started = true;
      fresh = false;
      if (keep() && cell.length <= MAX_CELL) cell += char;
    }
  }
  if (started || cell || row.length) endRow();
  return { header: header ?? [], rows, total };
}
