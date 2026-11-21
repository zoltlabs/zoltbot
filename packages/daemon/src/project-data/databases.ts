// M8: one SQLite file per project in the daemon's data folder, shared by the project's agents.
// Statements run in a child process (sqlite-child.ts) so none can stall the daemon.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { checkSql } from "./sql-check.js";
import { type ChildRequest, runSqlite } from "./sqlite-child.js";

export const PROJECT_DB_MAX_BYTES = 200 * 1024 * 1024;
/** Characters of a tool result; the host tool dispatcher refuses more than 4000. */
export const PROJECT_DB_RESULT_CHARS = 3800;
const TOOL_TIMEOUT_MS = 10_000;
const PAGE_TIMEOUT_MS = 20_000;

export type Cell = string | number | null | { bytes: number };
export interface TableInfo {
  name: string;
  columns: string[];
  rows: number;
}
export interface RowsResult {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}
export interface ExecResult extends Partial<RowsResult> {
  changes: number;
  lastInsertRowid?: number | string | null;
}

/** SQLite's messages, in the shape the tool dispatcher passes on to the agent. */
function toolError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/^project_db_[a-z_]+(: |$)/.test(message)) return error as Error;
  const detail = message
    .replace(/[^A-Za-z0-9_.,;:'"() -]/g, " ")
    .trim()
    .slice(0, 200);
  return new Error(detail ? `project_db_error: ${detail}` : "project_db_error");
}

/** Drops rows, then the rows and columns, until the result fits a tool result. */
function fit<T extends Partial<RowsResult>>(result: T, maxChars: number): T {
  const rows = result.rows;
  if (!rows) return result;
  while (rows.length && JSON.stringify(result).length > maxChars) {
    rows.pop();
    result.truncated = true;
  }
  if (JSON.stringify(result).length <= maxChars) return result;
  const { columns: _columns, rows: _rows, ...rest } = result;
  return { ...rest, truncated: true } as T;
}

export class ProjectDatabases {
  private readonly live = new Set<ChildProcess>();

  constructor(
    readonly directory: string,
    readonly maxBytes = PROJECT_DB_MAX_BYTES,
    private readonly timeouts = { tool: TOOL_TIMEOUT_MS, page: PAGE_TIMEOUT_MS },
  ) {}

  /** The project's file. The id is hashed, so no id can name a path outside the folder. */
  file(projectId: string): string {
    if (!projectId) throw new Error("project_db_project_required");
    const name = createHash("sha256").update(projectId).digest("hex").slice(0, 32);
    return path.join(this.directory, `${name}.sqlite`);
  }

  bytes(projectId: string): number {
    const file = this.file(projectId);
    return existsSync(file) ? statSync(file).size : 0;
  }

  /** Kills running children, so none outlives the daemon. */
  close() {
    for (const child of this.live) child.kill("SIGKILL");
  }

  private run<T>(
    projectId: string,
    request: Omit<ChildRequest, "file" | "write" | "maxBytes">,
    write: boolean,
    timeoutMs: number,
  ) {
    let file = this.file(projectId);
    if (write) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // A project with no file yet reads as an empty database.
    else if (!existsSync(file)) file = ":memory:";
    return runSqlite<T>(
      { ...request, file, write, maxBytes: this.maxBytes },
      { timeoutMs, tmp: path.join(this.directory, "tmp"), live: this.live },
    );
  }

  /** `project_db_query`: one SELECT, checked by text and by SQLite as read-only. */
  async query(projectId: string, sql: string, maxChars = PROJECT_DB_RESULT_CHARS) {
    checkSql(sql, "query");
    let result: RowsResult;
    try {
      result = await this.run<RowsResult>(
        projectId,
        { op: "query", sql, maxChars },
        false,
        this.timeouts.tool,
      );
    } catch (error) {
      throw toolError(error);
    }
    const fitted = fit(result, maxChars);
    if (!fitted.columns)
      throw new Error("project_db_result_too_large: select fewer or shorter columns");
    return fitted;
  }

  /** `project_db_exec`: one write statement. Callers check the session may write. */
  async exec(projectId: string, sql: string, maxChars = PROJECT_DB_RESULT_CHARS) {
    checkSql(sql, "exec");
    try {
      const result = await this.run<ExecResult>(
        projectId,
        { op: "exec", sql, maxChars },
        true,
        this.timeouts.tool,
      );
      // The write is done; a result too large to return still reports it.
      return fit(result, maxChars);
    } catch (error) {
      throw toolError(error);
    }
  }

  tables(projectId: string) {
    return this.run<TableInfo[]>(projectId, { op: "tables" }, false, this.timeouts.page);
  }

  /** A page of a table for the Data page. */
  rows(projectId: string, table: string, offset = 0, limit = 100) {
    return this.run<{ columns: string[]; rows: Cell[][]; total: number }>(
      projectId,
      { op: "rows", table, offset, limit },
      false,
      this.timeouts.page,
    );
  }

  /** The whole table as CSV, up to 20 MB of text. */
  csv(projectId: string, table: string) {
    return this.run<{ csv: string; truncated: boolean }>(
      projectId,
      { op: "csv", table },
      false,
      this.timeouts.page,
    );
  }
}
