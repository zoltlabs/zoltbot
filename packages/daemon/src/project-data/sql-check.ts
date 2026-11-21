// M8: the text checks an agent's SQL passes before SQLite prepares it. SQLite's own checks
// (one statement per prepare, `stmt.readonly`, extension loading off) run as well; these
// reject what SQLite would allow on a statement it calls read-only, such as ATTACH and PRAGMA.

export type SqlMode = "query" | "exec";

/** Words that reach outside the project's file or change the connection. */
const BLOCKED =
  /\b(?:attach|detach|vacuum|load_extension|pragma(?:_\w+)?|sqlite_dbpage|fts3_tokenizer)\b/i;
/** Transaction control would leave a transaction open between calls. */
const EXEC_FIRST = new Set([
  "create",
  "drop",
  "alter",
  "insert",
  "update",
  "delete",
  "replace",
  "with",
]);
const QUERY_FIRST = new Set(["select", "with"]);
export const SQL_MAX_LENGTH = 20000;

/**
 * Replaces string literals with `''` and comments with a space, keeping quoted identifiers,
 * so a blocked word inside `"..."`, `` `...` `` or `[...]` is still found.
 */
export function stripSql(sql: string): string {
  let out = "";
  let at = 0;
  while (at < sql.length) {
    const char = sql[at] as string;
    const next = sql[at + 1];
    if (char === "'") {
      let end = at + 1;
      for (;;) {
        end = sql.indexOf("'", end);
        if (end < 0) throw new Error("project_db_sql_rejected: a string is not closed");
        if (sql[end + 1] === "'") end += 2;
        else break;
      }
      out += "''";
      at = end + 1;
    } else if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", at);
      out += " ";
      at = end < 0 ? sql.length : end + 1;
    } else if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", at + 2);
      if (end < 0) throw new Error("project_db_sql_rejected: a comment is not closed");
      out += " ";
      at = end + 2;
    } else if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      const end = sql.indexOf(close, at + 1);
      if (end < 0) throw new Error("project_db_sql_rejected: a name is not closed");
      out += sql.slice(at, end + 1);
      at = end + 1;
    } else {
      out += char;
      at++;
    }
  }
  return out;
}

/** Throws `project_db_sql_rejected` unless `sql` is one statement the mode allows. */
export function checkSql(sql: string, mode: SqlMode): void {
  if (typeof sql !== "string" || !sql.trim())
    throw new Error("project_db_sql_rejected: send one SQL statement");
  if (sql.length > SQL_MAX_LENGTH)
    throw new Error("project_db_sql_rejected: the statement is too long");
  if (sql.includes("\0")) throw new Error("project_db_sql_rejected: the statement has a null byte");
  const plain = stripSql(sql);
  const body = plain.trim().replace(/;\s*$/, "");
  if (body.includes(";")) throw new Error("project_db_sql_rejected: send one statement at a time");
  const blocked = BLOCKED.exec(plain);
  if (blocked)
    throw new Error(`project_db_sql_rejected: ${blocked[0].toUpperCase()} is not allowed`);
  // Temporary tables live outside the project's file and its size cap.
  const unquoted = plain.replace(/["`[\]]/g, "");
  if (/\bcreate\s+temp(?:orary)?\b|\btemp\s*\./i.test(unquoted))
    throw new Error("project_db_sql_rejected: temporary tables are not allowed");
  const first = /^[a-z]+/i.exec(body)?.[0]?.toLowerCase() ?? "";
  if (mode === "query" && !QUERY_FIRST.has(first))
    throw new Error("project_db_sql_rejected: project_db_query runs one SELECT");
  if (mode === "exec" && !EXEC_FIRST.has(first))
    throw new Error(
      "project_db_sql_rejected: project_db_exec runs CREATE, DROP, ALTER, INSERT, UPDATE, DELETE or REPLACE",
    );
}
