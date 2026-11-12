import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import { parse } from "@zoltbot/protocol";
import { type MacExecResult, MacExecResultSchema } from "@zoltbot/runner-protocol";
import { acquireOwnerLock, SqliteDriver } from "@zoltbot/store";

export interface MacRequestScope {
  orgId: string;
  userId: string;
  taskId: string;
  requestId: string;
}
type State = "executing" | "uncertain" | "completed";
interface Row {
  binding: string;
  state: State;
  result: string | null;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const requestKey = (scope: MacRequestScope) =>
  digest([scope.orgId, scope.userId, scope.taskId, scope.requestId]);

/** Claim before spawning. A crash never turns an uncertain command into a second execution. */
export class MacExecJournal {
  private closed = false;
  private constructor(
    private readonly database: SqliteDriver,
    private readonly owner: ReturnType<typeof acquireOwnerLock>,
  ) {}
  static open(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error("mac_journal_unavailable");
    let owner: ReturnType<typeof acquireOwnerLock> | undefined, database: SqliteDriver | undefined;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
      chmodSync(directory, 0o700);
      const file = path.join(directory, "mac-exec.db");
      for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
        try {
          const stat = lstatSync(candidate);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      owner = acquireOwnerLock(path.join(directory, "mac-exec.lock"));
      database = new SqliteDriver(file);
      chmodSync(file, 0o600);
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.pragma("foreign_keys = ON");
      database.exec(`CREATE TABLE IF NOT EXISTS mac_requests (
        request_key TEXT PRIMARY KEY, binding TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('executing','uncertain','completed')), result TEXT);
        CREATE TABLE IF NOT EXISTS mac_approvals (
        signature_hash TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE REFERENCES mac_requests(request_key));
        UPDATE mac_requests SET state='uncertain' WHERE state='executing';`);
      return new MacExecJournal(database, owner);
    } catch {
      database?.close();
      owner?.release();
      throw new Error("mac_journal_unavailable");
    }
  }
  /** The execution host must verify the signed approval and current authority before calling this. */
  begin(scope: MacRequestScope, binding: string, signature: string) {
    this.check();
    if (
      Object.keys(scope).length !== 4 ||
      [scope.orgId, scope.userId, scope.taskId, scope.requestId].some(
        (value) =>
          typeof value !== "string" || !value || value.length > 200 || value.includes("\0"),
      ) ||
      !/^[a-f0-9]{64}$/.test(binding) ||
      !/^[A-Za-z0-9_-]{86}$/.test(signature)
    )
      throw new Error("mac_request_invalid");
    const key = requestKey(scope),
      signatureHash = digest(signature);
    return this.database
      .transaction(() => {
        const prior = this.database
          .prepare("SELECT binding,state,result FROM mac_requests WHERE request_key=?")
          .get(key) as Row | undefined;
        if (prior) {
          if (prior.binding !== binding) throw new Error("mac_request_conflict");
          if (prior.state === "completed")
            return { state: "completed" as const, result: this.result(scope, prior.result) };
          return { state: prior.state };
        }
        if (
          this.database
            .prepare("SELECT 1 FROM mac_approvals WHERE signature_hash=?")
            .get(signatureHash)
        )
          throw new Error("mac_approval_replayed");
        this.database
          .prepare("INSERT INTO mac_requests(request_key,binding,state) VALUES(?,?,'executing')")
          .run(key, binding);
        this.database
          .prepare("INSERT INTO mac_approvals(signature_hash,request_key) VALUES(?,?)")
          .run(signatureHash, key);
        return { state: "new" as const };
      })
      .immediate();
  }
  complete(scope: MacRequestScope, binding: string, result: MacExecResult) {
    this.check();
    const value = this.result(scope, JSON.stringify(result));
    const changed = this.database
      .prepare(
        "UPDATE mac_requests SET state='completed',result=? WHERE request_key=? AND binding=? AND state='executing'",
      )
      .run(JSON.stringify(value), requestKey(scope), binding);
    if (changed.changes !== 1) throw new Error("mac_request_conflict");
  }
  private result(scope: MacRequestScope, raw: string | null) {
    try {
      if (!raw || raw.length > 2000000) throw new Error();
      const result = parse(MacExecResultSchema, JSON.parse(raw));
      if (result.requestId !== scope.requestId || result.taskId !== scope.taskId) throw new Error();
      return result;
    } catch {
      throw new Error("mac_result_unavailable");
    }
  }
  private check() {
    if (this.closed) throw new Error("mac_journal_closed");
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.database.close();
    } finally {
      this.owner.release();
    }
  }
}
