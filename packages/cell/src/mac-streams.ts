import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import {
  type MacOutputChunk,
  MacOutputChunkSchema,
  type MacOutputSnapshot,
  MacOutputSnapshotSchema,
  parse,
  TaskSchema,
} from "@zoltbot/protocol";
import { MacExecResultSchema } from "@zoltbot/runner-protocol";
import type { Store } from "@zoltbot/store/portable";
import type { CellMacRecords } from "./mac-records.js";

interface StreamRow {
  last_seq: number;
  stdout: string;
  stderr: string;
  truncated: number;
  missing: number;
  last_hash: string;
}
const encoder = new TextEncoder();
function tail(previous: string, data: string, limit: number) {
  const bytes = encoder.encode(previous + data);
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return { text: new TextDecoder().decode(bytes.subarray(start)), truncated: bytes.length > limit };
}
/** Mutable bounded tails, never full output in the event log. Completion reads the authoritative result. */
export class CellMacStreams {
  constructor(
    private readonly store: Store,
    private readonly records: CellMacRecords,
    private readonly owner: { orgId: string; userId: string },
  ) {
    store.database.exec(`CREATE TABLE IF NOT EXISTS cell_mac_streams (
      id TEXT PRIMARY KEY REFERENCES cell_mac_requests(id) ON DELETE CASCADE,last_seq INTEGER NOT NULL,
      stdout TEXT NOT NULL,stderr TEXT NOT NULL,truncated INTEGER NOT NULL,missing INTEGER NOT NULL,last_hash TEXT NOT NULL)`);
  }
  async append(
    claims: CellTokenClaims,
    connectionId: string,
    raw: MacOutputChunk,
  ): Promise<boolean> {
    const chunk = parse(MacOutputChunkSchema, structuredClone(raw));
    if (encoder.encode(chunk.data).byteLength > 65536) throw new Error("forbidden");
    this.records.streamScope(claims, connectionId, chunk.taskId, chunk.requestId);
    const digest = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          encoder.encode(JSON.stringify([chunk.chunkSeq, chunk.stream, chunk.data])),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const scope = this.records.streamScope(claims, connectionId, chunk.taskId, chunk.requestId);
    if (scope.complete) return false;
    return this.store.database
      .transaction(() => {
        const prior = this.store.database
          .prepare("SELECT * FROM cell_mac_streams WHERE id=?")
          .get(scope.id) as StreamRow | undefined;
        if (prior && chunk.chunkSeq <= prior.last_seq) {
          if (chunk.chunkSeq === prior.last_seq && digest !== prior.last_hash)
            throw new Error("command_conflict");
          return false;
        }
        const stdout = tail(
            prior?.stdout ?? "",
            chunk.stream === "stdout" ? chunk.data : "",
            262144,
          ),
          stderr = tail(prior?.stderr ?? "", chunk.stream === "stderr" ? chunk.data : "", 65536),
          missing = !!prior?.missing || chunk.chunkSeq !== (prior?.last_seq ?? 0) + 1;
        this.store.database
          .prepare(`INSERT INTO cell_mac_streams VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET last_seq=excluded.last_seq,stdout=excluded.stdout,stderr=excluded.stderr,
        truncated=excluded.truncated,missing=excluded.missing,last_hash=excluded.last_hash`)
          .run(
            scope.id,
            chunk.chunkSeq,
            stdout.text,
            stderr.text,
            prior?.truncated || stdout.truncated || stderr.truncated ? 1 : 0,
            missing ? 1 : 0,
            digest,
          );
        return true;
      })
      .immediate();
  }
  read(claims: CellTokenClaims, taskId: string, requestId: string): MacOutputSnapshot {
    if (
      claims.kind !== "client" ||
      claims.org !== this.owner.orgId ||
      claims.sub !== this.owner.userId
    )
      throw new Error("forbidden");
    const task = parse(TaskSchema, this.store.record("task", taskId));
    if (task.createdBy.id !== claims.sub) throw new Error("forbidden");
    const row = this.store.database
      .prepare("SELECT id,state,result FROM cell_mac_requests WHERE task_id=? AND request_id=?")
      .get(taskId, requestId) as { id: string; state: string; result: string | null } | undefined;
    if (!row) throw new Error("mac_output_unavailable");
    const stream = this.store.database
      .prepare("SELECT * FROM cell_mac_streams WHERE id=?")
      .get(row.id) as StreamRow | undefined;
    const result =
      row.state === "complete"
        ? parse(MacExecResultSchema, JSON.parse(row.result ?? "null"))
        : undefined;
    return parse(MacOutputSnapshotSchema, {
      taskId,
      requestId,
      state: result ? "complete" : ["approved", "sent"].includes(row.state) ? "running" : row.state,
      lastChunkSeq: stream?.last_seq ?? 0,
      stdout: result?.stdout ?? stream?.stdout ?? "",
      stderr: result?.stderr ?? stream?.stderr ?? "",
      truncated: result?.truncated ?? !!stream?.truncated,
      missingChunks: result ? false : !!stream?.missing,
      ...(result ? { exitCode: result.exitCode } : {}),
    });
  }
}
