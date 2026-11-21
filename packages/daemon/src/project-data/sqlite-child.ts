// M8: every statement on a project database runs in a short-lived child process. better-sqlite3
// can't interrupt a running statement, so a runaway query (an endless recursive CTE, a huge sort)
// would otherwise stall the daemon. The child is killed at its deadline, its SQLite heap is
// capped, and its temporary files go to a folder of their own.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { sqliteModulePath } from "@zoltbot/store";

export interface ChildRequest {
  file: string;
  write: boolean;
  op: "query" | "exec" | "tables" | "rows" | "csv";
  maxBytes: number;
  sql?: string;
  table?: string;
  offset?: number;
  limit?: number;
  maxChars?: number;
}

/** SQLite's own memory, per child. */
const HEAP_BYTES = 256 * 1024 * 1024;
/** Characters a Data page cell keeps; agents' tool results keep fewer. */
const PAGE_CELL_CHARS = 2000;
const TOOL_CELL_CHARS = 1000;
const NAME_CHARS = 200;
const ROWS_SCANNED = 1000;
/** CSV size, counted in bytes as the CSV travels back (JSON-escaped). */
const CSV_MAX_BYTES = 20 * 1024 * 1024;
const OUTPUT_LIMIT = 32 * 1024 * 1024;
/** Children that may run at once; later requests wait their turn. */
const MAX_CHILDREN = 3;
const CHILD_ARGS = ["--max-old-space-size=256", "-e"];

// Plain JavaScript, run with `node -e`. It reads one request from stdin and writes one result.
const CHILD_SOURCE = String.raw`
const fs = require("fs");
const request = JSON.parse(fs.readFileSync(0, "utf8"));
process.umask(0o077);
const Database = require(request.module);
const fail = (message) => { throw new Error(message); };
function cell(value, limit) {
  if (value === null || value === undefined) return [null, false];
  if (typeof value === "bigint")
    return [Number.isSafeInteger(Number(value)) ? Number(value) : value.toString(), false];
  if (typeof value === "number") return [value, false];
  if (Buffer.isBuffer(value)) return [{ bytes: value.length }, false];
  const text = String(value);
  return limit && text.length > limit ? [text.slice(0, limit) + "…", true] : [text, false];
}
const clipName = (name) => (name.length > request.nameChars ? name.slice(0, request.nameChars) + "…" : name);
function readRows(statement, base) {
  const columns = statement.columns().map((column) => clipName(column.name));
  const rows = [];
  let size = JSON.stringify({ ...base, columns, rows: [], truncated: false }).length;
  let truncated = false;
  let scanned = 0;
  for (const raw of statement.raw(true).iterate()) {
    if (++scanned > request.rowsScanned) { truncated = true; break; }
    let clipped = false;
    const row = raw.map((value) => { const [next, cut] = cell(value, request.toolCellChars); clipped = clipped || cut; return next; });
    const length = JSON.stringify(row).length + 1;
    if (size + length > request.maxChars) { truncated = true; break; }
    size += length;
    truncated = truncated || clipped;
    rows.push(row);
  }
  return { ...base, columns, rows, truncated };
}
const quote = (name) => '"' + name.replace(/"/g, '""') + '"';
function table(db, name) {
  const found = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
  if (!found || name.startsWith("sqlite_")) fail("project_db_table_not_found");
  return quote(name);
}
function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = Buffer.isBuffer(value) ? value.toString("base64") : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
const ops = {
  query(db) {
    const statement = db.prepare(request.sql);
    if (!statement.readonly || !statement.reader)
      fail("project_db_sql_rejected: project_db_query runs one SELECT");
    return readRows(statement, {});
  },
  exec(db) {
    const total = () => Number(db.prepare("SELECT total_changes() AS n").get().n);
    const rowid = () => db.prepare("SELECT last_insert_rowid() AS id").get().id;
    const before = total();
    const rowidBefore = rowid();
    const statement = db.prepare(request.sql);
    let result;
    if (statement.reader) result = readRows(statement, { changes: 0 });
    else {
      statement.run();
      result = { changes: 0, lastInsertRowid: null };
      const after = rowid();
      if (total() > before && after !== rowidBefore) result.lastInsertRowid = cell(after, 0)[0];
    }
    if (db.inTransaction) { db.exec("ROLLBACK"); fail("project_db_sql_rejected: the statement left a transaction open"); }
    result.changes = total() - before;
    return result;
  },
  tables(db) {
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all();
    const tables = [];
    for (const { name } of names) {
      if (name.length > request.tableNameChars) continue;
      try {
        const columns = db.prepare("SELECT * FROM " + quote(name) + " LIMIT 0").columns().map((c) => clipName(c.name));
        const rows = Number(db.prepare("SELECT count(*) AS n FROM " + quote(name)).get().n);
        tables.push({ name, columns, rows });
      } catch {
        // A table that can't be read is left out rather than hiding the others.
      }
    }
    return tables;
  },
  rows(db) {
    const name = table(db, request.table);
    const offset = Math.max(0, Math.floor(Number(request.offset) || 0));
    const limit = Math.min(500, Math.max(1, Math.floor(Number(request.limit) || 100)));
    const statement = db.prepare("SELECT * FROM " + name + " LIMIT ? OFFSET ?");
    const columns = statement.columns().map((c) => clipName(c.name));
    const rows = statement.raw(true).all(limit, offset).map((row) => row.map((value) => cell(value, request.pageCellChars)[0]));
    const total = Number(db.prepare("SELECT count(*) AS n FROM " + name).get().n);
    return { columns, rows, total };
  },
  csv(db) {
    const statement = db.prepare("SELECT * FROM " + table(db, request.table));
    const lines = [statement.columns().map((c) => csvField(c.name)).join(",")];
    const bytes = (line) => Buffer.byteLength(JSON.stringify(line), "utf8") + 2;
    let size = bytes(lines[0]);
    let truncated = false;
    for (const row of statement.raw(true).iterate()) {
      const line = row.map(csvField).join(",");
      const length = bytes(line);
      if (size + length > request.csvBytes) { truncated = true; break; }
      size += length;
      lines.push(line);
    }
    return { csv: lines.join("\r\n") + "\r\n", truncated };
  },
};
let db;
let output;
try {
  db = request.file === ":memory:"
    ? new Database(":memory:")
    : new Database(request.file, { fileMustExist: !request.write });
  // Readers open read-write but query-only, so they can roll back a hot journal that a writer
  // killed at its deadline left behind.
  if (!request.write) db.pragma("query_only = ON");
  db.defaultSafeIntegers(true);
  db.pragma("hard_heap_limit = " + request.heapBytes);
  db.pragma("trusted_schema = OFF");
  db.pragma("busy_timeout = 5000");
  if (request.write) {
    if (request.file !== ":memory:") fs.chmodSync(request.file, 0o600);
    const page = Number(db.pragma("page_size", { simple: true }));
    // SQLite refuses writes past this many pages with SQLITE_FULL.
    db.pragma("max_page_count = " + Math.max(1, Math.floor(request.maxBytes / page)));
  }
  output = { ok: true, result: ops[request.op](db) };
} catch (error) {
  const code = error && error.code;
  const message = String((error && error.message) || error);
  output = {
    ok: false,
    message: code === "SQLITE_FULL"
      ? "project_db_full: the project database reached its size limit"
      : code === "SQLITE_NOMEM"
        ? "project_db_too_large: the statement needs too much memory"
        : message,
  };
} finally {
  try { if (db) db.close(); } catch {}
}
process.stdout.write(JSON.stringify(output));
`;

/** Runs one request in a child and returns its result, or throws its error. */
export function runSqlite<T>(
  request: ChildRequest,
  options: { timeoutMs: number; tmp: string; live: Set<ChildProcess> },
) {
  mkdirSync(options.tmp, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({
    ...request,
    module: sqliteModulePath(),
    tmp: options.tmp,
    heapBytes: HEAP_BYTES,
    nameChars: NAME_CHARS,
    tableNameChars: 4096,
    toolCellChars: TOOL_CELL_CHARS,
    pageCellChars: PAGE_CELL_CHARS,
    rowsScanned: ROWS_SCANNED,
    csvBytes: CSV_MAX_BYTES,
  });
  return acquire().then(
    () =>
      new Promise<T>((resolve, reject) =>
        start(payload, options.timeoutMs, options.live, resolve, reject),
      ),
  );
}

const waiting: Array<() => void> = [];
let running = 0;

function acquire() {
  if (running < MAX_CHILDREN) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

function childEnv() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "ELECTRON_RUN_AS_NODE"])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}

function start<T>(
  payload: string,
  timeoutMs: number,
  live: Set<ChildProcess>,
  resolve: (value: T) => void,
  reject: (error: Error) => void,
) {
  const tmp = (JSON.parse(payload) as { tmp: string }).tmp;
  const child = spawn(process.execPath, [...CHILD_ARGS, CHILD_SOURCE], {
    env: { ...childEnv(), SQLITE_TMPDIR: tmp, TMPDIR: tmp },
    stdio: ["pipe", "pipe", "ignore"],
  });
  live.add(child);
  const chunks: Buffer[] = [];
  let size = 0;
  let settled = false;
  const finish = (error: Error | undefined, value?: T) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    live.delete(child);
    release();
    if (error) reject(error);
    else resolve(value as T);
  };
  const timer = setTimeout(
    () =>
      finish(
        new Error(
          `project_db_timeout: the statement ran longer than ${Math.round(timeoutMs / 1000)} seconds`,
        ),
      ),
    timeoutMs,
  );
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > OUTPUT_LIMIT) finish(new Error("project_db_too_large: the result is too large"));
    else chunks.push(chunk);
  });
  child.on("error", () => finish(new Error("project_db_unavailable")));
  child.on("close", () => {
    try {
      const output = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
        | { ok: true; result: T }
        | { ok: false; message: string };
      if (output.ok) finish(undefined, output.result);
      else finish(new Error(output.message));
    } catch {
      finish(new Error("project_db_failed"));
    }
  });
  child.stdin.on("error", () => {});
  child.stdin.end(payload);
}
