import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { type Command, handle } from "@zoltbot/core";
import { afterEach, describe, expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "../private-input.js";
import { runtimeTools } from "../runtime-tools.js";
import { projectDataApi } from "./api.js";
import { ProjectDatabases } from "./databases.js";
import { checkSql } from "./sql-check.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function databases(maxBytes?: number, timeouts?: { tool: number; page: number }) {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/project-data-"));
  roots.push(root);
  return new ProjectDatabases(path.join(root, "project-data"), maxBytes, timeouts);
}

describe("SQL checks", () => {
  const rejected = (sql: string, mode: "query" | "exec") =>
    expect(() => checkSql(sql, mode), sql).toThrow(/^project_db_sql_rejected/);

  it("rejects ATTACH, DETACH, PRAGMA, VACUUM and extension loading in either tool", () => {
    for (const mode of ["query", "exec"] as const)
      for (const sql of [
        "ATTACH DATABASE '/tmp/other.db' AS other",
        "attach '/tmp/x' as x",
        "DETACH other",
        "PRAGMA writable_schema = ON",
        "pragma user_version",
        "SELECT * FROM pragma_database_list",
        "VACUUM INTO '/tmp/copy.db'",
        "SELECT load_extension('/tmp/evil')",
        "SELECT \"load_extension\"('/tmp/evil')",
        "SELECT [load_extension]('/tmp/evil')",
        "SELECT/**/load_extension('x')",
        "INSERT INTO t VALUES (load_extension('x'))",
        "CREATE VIEW v AS SELECT load_extension('x')",
        "WITH a AS (SELECT 1) SELECT * FROM a, pragma_table_info('t')",
      ])
        rejected(sql, mode);
  });

  it("rejects more than one statement, even after a comment or a string", () => {
    for (const sql of [
      "SELECT 1; SELECT 2",
      "SELECT 1 /* x */; DROP TABLE t",
      "SELECT ';'; DELETE FROM t",
      "SELECT 1;\n-- trailing\nDELETE FROM t",
      "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)",
    ])
      rejected(sql, sql.startsWith("INSERT") ? "exec" : "query");
    expect(() => checkSql("SELECT 1;", "query")).not.toThrow();
    expect(() => checkSql("SELECT 'a;b' -- ; not a statement", "query")).not.toThrow();
  });

  it("keeps writes out of the query tool and transactions out of both", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "DELETE FROM t",
      "DROP TABLE t",
      "CREATE TABLE x (a)",
      "BEGIN",
      "VALUES (1)",
    ])
      rejected(sql, "query");
    for (const sql of ["BEGIN", "COMMIT", "SAVEPOINT a", "ROLLBACK", "SELECT 1"])
      rejected(sql, "exec");
    for (const sql of [
      "CREATE TEMP TABLE x (a)",
      'CREATE TABLE "temp".x (a)',
      "CREATE TABLE temp . x (a)",
    ])
      rejected(sql, "exec");
  });

  it("rejects unclosed strings and comments, and empty or oversized SQL", () => {
    for (const sql of [
      "SELECT 'open",
      "SELECT 1 /* open",
      'SELECT "open',
      "",
      "  ",
      `SELECT '${"x".repeat(20001)}'`,
    ])
      rejected(sql, "query");
  });

  it("allows names and text that only contain a blocked word", () => {
    expect(() => checkSql("SELECT attachment, pragmatic FROM files", "query")).not.toThrow();
    expect(() =>
      checkSql("INSERT INTO notes (body) VALUES ('ATTACH the file; PRAGMA')", "exec"),
    ).not.toThrow();
  });
});

describe("project databases", () => {
  it("keeps each project in its own file and refuses writes through the query tool", async () => {
    const data = databases();
    await data.exec("project-a", "CREATE TABLE leads (name TEXT, score INTEGER)");
    expect(
      await data.exec("project-a", "INSERT INTO leads VALUES ('Acme', 3), ('Globex', 5)"),
    ).toEqual({ changes: 2, lastInsertRowid: 2 });
    // DDL reports no changes, not the previous statement's.
    expect(await data.exec("project-a", "CREATE TABLE notes (body TEXT)")).toEqual({
      changes: 0,
      lastInsertRowid: null,
    });
    expect(await data.query("project-a", "SELECT name FROM leads ORDER BY score DESC")).toEqual({
      columns: ["name"],
      rows: [["Globex"], ["Acme"]],
      truncated: false,
    });
    await expect(data.query("project-b", "SELECT * FROM leads")).rejects.toThrow(
      /^project_db_error: no such table/,
    );
    // A CTE that deletes passes the first-word check; SQLite's readonly check stops it.
    await expect(
      data.query("project-a", "WITH gone AS (SELECT 1) DELETE FROM leads"),
    ).rejects.toThrow(/project_db_sql_rejected/);
    expect((await data.query("project-a", "SELECT count(*) AS n FROM leads")).rows).toEqual([[2]]);
    expect(data.file("../../etc")).toMatch(/project-data\/[0-9a-f]{32}\.sqlite$/);
  });

  it("caps each project's file at its size limit", async () => {
    const data = databases(64 * 1024);
    await data.exec("p", "CREATE TABLE blobs (b BLOB)");
    await expect(
      data.exec(
        "p",
        "INSERT INTO blobs WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 100) SELECT randomblob(4000) FROM c",
      ),
    ).rejects.toThrow(/^project_db_full/);
    await data.exec("p", "INSERT INTO blobs VALUES (randomblob(4000))");
    await expect(
      data.exec(
        "p",
        "INSERT INTO blobs WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 100) SELECT randomblob(4000) FROM c",
      ),
    ).rejects.toThrow(/^project_db_full/);
    expect(data.bytes("p")).toBeLessThanOrEqual(64 * 1024);
    // Reads still work once the file is full.
    expect((await data.query("p", "SELECT count(*) FROM blobs")).rows).toEqual([[1]]);
  });

  it("stops a runaway statement without blocking the daemon", async () => {
    const data = databases(undefined, { tool: 1500, page: 1500 });
    const started = Date.now();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    try {
      await expect(
        data.query(
          "p",
          "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x < 0",
        ),
      ).rejects.toThrow(/^project_db_timeout/);
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(5000);
    // The event loop kept running while the child worked.
    expect(ticks).toBeGreaterThan(10);
    await expect(data.query("p", "SELECT hex(zeroblob(400000000))")).rejects.toThrow(
      /^project_db_(too_large|error)/,
    );
  });

  it("reads again after a writer is killed mid-write, and kills children on close", async () => {
    const data = databases(undefined, { tool: 1500, page: 1500 });
    await data.exec("p", "CREATE TABLE t (x INTEGER)");
    await data.exec("p", "INSERT INTO t VALUES (1)");
    await expect(
      data.exec(
        "p",
        "INSERT INTO t WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x < 0 OR x < 3000000000",
      ),
    ).rejects.toThrow(/^project_db_(timeout|full)/);
    // The killed writer left a hot journal; the next reader rolls it back.
    expect(existsSync(`${data.file("p")}-journal`)).toBe(true);
    const result = await data.query("p", "SELECT count(*) AS n FROM t WHERE x = 1");
    expect(result.rows).toEqual([[1]]);
    expect((await data.tables("p")).map((table) => table.name)).toEqual(["t"]);
    const pending = data.query(
      "p",
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x < 0",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    data.close();
    await expect(pending).rejects.toThrow(/^project_db_failed/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("cuts query results to fit a tool result and says so", async () => {
    const data = databases();
    await data.exec("p", "CREATE TABLE rows (n INTEGER, body TEXT)");
    await data.exec(
      "p",
      "INSERT INTO rows WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 400) SELECT n, printf('%.*c', 300, 'x') FROM c",
    );
    const result = await data.query("p", "SELECT * FROM rows");
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(result).length).toBeLessThan(4000);
    await data.exec("p", "INSERT INTO rows VALUES (0, printf('%.*c', 5000, 'y'))");
    const long = await data.query("p", "SELECT body FROM rows WHERE n = 0");
    expect(long.truncated).toBe(true);
    expect(JSON.stringify(long).length).toBeLessThan(4000);
    // Long column names count too; a write still reports what it did.
    const wide = Array.from({ length: 30 }, (_, i) => `n AS "${"c".repeat(190)}${i}"`).join(", ");
    await expect(data.query("p", `SELECT ${wide} FROM rows`)).rejects.toThrow(
      /^project_db_result_too_large/,
    );
    const returned = await data.exec("p", `INSERT INTO rows VALUES (1000, 'z') RETURNING ${wide}`);
    expect(returned).toEqual({ changes: 1, truncated: true });
  });

  it("lists tables, pages rows and exports CSV for the Data page", async () => {
    const data = databases();
    expect(await data.tables("p")).toEqual([]);
    await data.exec("p", 'CREATE TABLE "invoices" (id INTEGER, note TEXT, file BLOB)');
    await data.exec(
      "p",
      "INSERT INTO invoices VALUES (1, 'Paid, \"in full\"', x'0102'), (2, NULL, printf('%.*c', 5000, 'w'))",
    );
    expect(await data.tables("p")).toEqual([
      { name: "invoices", columns: ["id", "note", "file"], rows: 2 },
    ]);
    const page = await data.rows("p", "invoices", 1, 10);
    expect(page.total).toBe(2);
    expect(page.rows[0]?.[0]).toBe(2);
    // Long cells are clipped for the page.
    expect(String(page.rows[0]?.[2]).length).toBeLessThanOrEqual(2001);
    expect((await data.rows("p", "invoices")).rows[0]).toEqual([
      1,
      'Paid, "in full"',
      { bytes: 2 },
    ]);
    // Out-of-range paging is clamped, not passed to SQLite.
    expect((await data.rows("p", "invoices", -5, -1)).rows).toHaveLength(1);
    expect((await data.csv("p", "invoices")).csv.split("\r\n")[1]).toBe(
      '1,"Paid, ""in full""",AQI=',
    );
    await expect(data.rows("p", "missing")).rejects.toThrow("project_db_table_not_found");
    await expect(data.rows("p", 'invoices" UNION SELECT 1 --')).rejects.toThrow(
      "project_db_table_not_found",
    );
  });
});

describe("project database tools", () => {
  it("gives a project chat both tools, and a read-only session only the query", async () => {
    const f = await runtimeFixture();
    let n = 0;
    // As the owner, who confirms a permission change.
    const change = (command: Command) => {
      const commandId = `pd:${++n}`;
      f.store.dispatch(commandId, (s) =>
        handle(s, command, { commandId, at, actor: { kind: "human", id: "local-owner" } }),
      );
    };
    const data = databases();
    try {
      change({
        type: "create",
        kind: "project",
        value: {
          id: "a",
          name: "a",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 0,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
        },
      });
      change({ type: "transition", kind: "session", id: "session", to: "ready" });
      change({ type: "transition", kind: "session", id: "session", to: "running" });
      change({
        type: "create",
        kind: "turn",
        value: {
          id: "turn",
          threadId: "thread",
          sessionId: "session",
          status: "running",
          origin: "human",
          startedAt: at,
        },
      });
      const context = {
        store: f.store,
        projectData: data,
        privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
        publish() {},
        async wake() {},
      };
      const tools = runtimeTools(context);
      const actor = {
        agentId: "profile",
        threadId: "thread",
        sessionId: "session",
        turnId: "turn",
      };
      const call = (name: string, sql: string) => {
        const tool = tools.tools.get(name);
        if (!tool) throw new Error(`missing ${name}`);
        return tool({ actor, arguments: { sql }, idempotencyKey: sql });
      };
      // A chat outside a project has no database.
      expect(tools.authorize(actor, "project_db_query", {})).toBe(false);
      change({
        type: "update",
        kind: "thread",
        id: "thread",
        changes: { projectId: "a", node: { type: "project", id: "a" } },
      });
      expect(tools.authorize(actor, "project_db_query", {})).toBe(true);
      // The fixture's agent and session are read-only.
      expect(tools.authorize(actor, "project_db_exec", {})).toBe(false);
      await expect(call("project_db_exec", "CREATE TABLE t (a)")).rejects.toThrow(
        "project_db_denied",
      );
      change({
        type: "update",
        kind: "agent",
        id: "profile",
        changes: { permissionProfile: "workspace_write" },
        confirmed: true,
      });
      change({
        type: "create",
        kind: "settings",
        value: {
          key: "runtime.configuration.session",
          value: { profile: { permissionProfile: "workspace_write" } },
        },
      });
      expect(tools.authorize(actor, "project_db_exec", {})).toBe(true);
      expect(tools.authorize({ ...actor, threadId: "other" }, "project_db_exec", {})).toBe(false);
      expect(
        await call("project_db_exec", "CREATE TABLE results (name TEXT, passed INTEGER)"),
      ).toEqual({ changes: 0, lastInsertRowid: null });
      expect(await call("project_db_exec", "INSERT INTO results VALUES ('login', 1)")).toEqual({
        changes: 1,
        lastInsertRowid: 1,
      });
      expect(await call("project_db_query", "SELECT * FROM results")).toEqual({
        columns: ["name", "passed"],
        rows: [["login", 1]],
        truncated: false,
      });
      await expect(call("project_db_query", "ATTACH '/tmp/x' AS x")).rejects.toThrow(
        "project_db_sql_rejected",
      );
      // A private value is never written to the shared file.
      context.privacy.remember("synthetic-private-value-1234");
      await expect(
        call("project_db_exec", "INSERT INTO results VALUES ('synthetic-private-value-1234', 0)"),
      ).rejects.toThrow();
      expect(await call("project_db_query", "SELECT count(*) FROM results")).toMatchObject({
        rows: [[1]],
      });
      // The Data page reads the same file.
      const api = projectDataApi(f.store, data);
      expect(await api("projectData.tables", { projectId: "a" })).toMatchObject({
        tables: [{ name: "results", columns: ["name", "passed"], rows: 1 }],
        limitBytes: 200 * 1024 * 1024,
      });
      await expect(api("projectData.tables", { projectId: "missing" })).rejects.toThrow(
        "project_not_found",
      );
      expect(await api("other.method", {})).toBeUndefined();
    } finally {
      f.close();
    }
  });
});
