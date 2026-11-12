import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { parse } from "@zoltbot/protocol";
import { type RunnerEvent, RunnerEventSchema } from "@zoltbot/runner-protocol";
import type { RuntimeObservation } from "../runtime-observer.js";

export interface OutboxBinding {
  orgId: string;
  taskId: string;
  threadId: string;
  leaseId: string;
}
interface Pointer {
  offset: number;
  length: number;
}
const maximumLine = 2 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
class OutboxError extends Error {}
function writeAll(fd: number, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!written) throw new OutboxError("runner_outbox_unavailable");
    offset += written;
  }
}
function encoded(value: unknown) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > maximumLine) throw new OutboxError("runner_event_too_large");
  return bytes;
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** One process owns each task file. No Local store is an input to this journal. */
export class RunnerOutbox {
  readonly file: string;
  private readonly binding: OutboxBinding;
  private readonly index = new Map<number, Pointer>();
  private fd = -1;
  private size = 0;
  private highest = 0;
  private pendingBytes = 0;
  private acknowledged = 0;
  private initialized = false;
  constructor(
    private readonly options: {
      directory: string;
      binding: OutboxBinding;
      /** Reject any known private value in both metadata and events, before writing. */
      guard(value: unknown): void;
    },
  ) {
    this.binding = Object.freeze(structuredClone(options.binding));
    this.file = path.join(
      options.directory,
      `${hash(JSON.stringify([this.binding.orgId, this.binding.taskId]))}.jsonl`,
    );
    try {
      this.guard(this.header());
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      this.fd = openSync(
        this.file,
        constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      if (!fstatSync(this.fd).isFile()) throw new OutboxError("runner_outbox_unavailable");
      this.load();
      if (!this.initialized) {
        this.write(this.header());
        syncDirectory(path.dirname(this.file));
        this.initialized = true;
      }
      this.maybeCompact();
    } catch (error) {
      this.fail(error);
    }
  }
  get lastAck() {
    return this.acknowledged;
  }
  get nextSequence() {
    return this.highest + 1;
  }
  private header() {
    return { t: "header", version: 1, ...this.binding, lastAck: this.acknowledged };
  }
  private guard(value: unknown) {
    try {
      this.options.guard(value);
    } catch {
      throw new OutboxError("runner_outbox_private_value");
    }
  }
  private ensureOpen() {
    if (this.fd < 0) throw new OutboxError("runner_outbox_closed");
  }
  private sequence(value: unknown): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= Number.MAX_SAFE_INTEGER
    )
      throw new OutboxError("runner_outbox_corrupt");
    return value;
  }
  private frame(value: unknown): RunnerEvent {
    let frame: RunnerEvent;
    try {
      frame = parse(RunnerEventSchema, value);
    } catch {
      throw new OutboxError("runner_event_invalid");
    }
    if (
      frame.taskId !== this.binding.taskId ||
      frame.leaseId !== this.binding.leaseId ||
      !frame.sessionId
    )
      throw new OutboxError("runner_outbox_scope_conflict");
    this.sequence(frame.runnerSeq);
    this.guard(frame);
    return frame;
  }
  private acceptAck(sequence: number) {
    this.acknowledged = Math.max(this.acknowledged, sequence);
    this.highest = Math.max(this.highest, sequence);
    for (const id of this.index.keys()) {
      if (id > this.acknowledged) break;
      this.pendingBytes -= this.index.get(id)?.length ?? 0;
      this.index.delete(id);
    }
  }
  private consume(line: Buffer, offset: number, length: number) {
    if (line.length > maximumLine) throw new OutboxError("runner_outbox_corrupt");
    const row = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
    if (!row || typeof row !== "object") throw new OutboxError("runner_outbox_corrupt");
    if (!this.initialized) {
      if (
        row.t !== "header" ||
        row.version !== 1 ||
        Object.entries(this.binding).some(([key, value]) => row[key] !== value)
      )
        throw new OutboxError("runner_outbox_scope_conflict");
      this.guard(row);
      this.acceptAck(this.sequence(row.lastAck));
      this.initialized = true;
      return;
    }
    if (row.t === "ack") {
      this.acceptAck(this.sequence(row.sequence));
      return;
    }
    if (row.t !== "event") throw new OutboxError("runner_outbox_corrupt");
    const frame = this.frame(row.frame);
    if (row.hash !== hash(JSON.stringify(frame)) || frame.runnerSeq !== this.highest + 1)
      throw new OutboxError("runner_outbox_corrupt");
    this.highest = frame.runnerSeq;
    this.index.set(frame.runnerSeq, { offset, length });
    this.pendingBytes += length;
  }
  private load() {
    const chunk = Buffer.alloc(65536);
    let pending = Buffer.alloc(0),
      offset = 0,
      complete = 0;
    while (true) {
      const count = readSync(this.fd, chunk, 0, chunk.length, offset);
      if (!count) break;
      offset += count;
      pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline = pending.indexOf(10);
      while (newline >= 0) {
        this.consume(pending.subarray(0, newline), complete, newline + 1);
        complete += newline + 1;
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
      if (pending.length > maximumLine) throw new OutboxError("runner_outbox_corrupt");
    }
    if (pending.length) {
      ftruncateSync(this.fd, complete);
      fsyncSync(this.fd);
    }
    this.size = complete;
  }
  private write(value: unknown): Pointer {
    this.ensureOpen();
    const bytes = encoded(value);
    const pointer = { offset: this.size, length: bytes.length };
    writeAll(this.fd, bytes);
    fsyncSync(this.fd);
    this.size += bytes.length;
    return pointer;
  }
  append(observation: RuntimeObservation): RunnerEvent {
    this.ensureOpen();
    if (observation.threadId !== this.binding.threadId)
      throw new OutboxError("runner_outbox_scope_conflict");
    const frame = this.frame({
      taskId: this.binding.taskId,
      leaseId: this.binding.leaseId,
      runnerSeq: this.nextSequence,
      sessionId: observation.sessionId,
      event: observation.event,
      ...(observation.itemId ? { itemId: observation.itemId } : {}),
      ...(observation.turnId ? { turnId: observation.turnId } : {}),
    });
    if (Buffer.byteLength(JSON.stringify(frame)) > maximumLine - 1024)
      throw new OutboxError("runner_event_too_large");
    try {
      const pointer = this.write({ t: "event", hash: hash(JSON.stringify(frame)), frame });
      this.highest = frame.runnerSeq;
      this.index.set(frame.runnerSeq, pointer);
      this.pendingBytes += pointer.length;
      return frame;
    } catch (error) {
      return this.fail(error);
    }
  }
  acknowledge(sequence: number) {
    this.ensureOpen();
    this.sequence(sequence);
    if (sequence <= this.acknowledged) return;
    try {
      this.write({ t: "ack", sequence });
      this.acceptAck(sequence);
      this.maybeCompact();
    } catch (error) {
      this.fail(error);
    }
  }
  private maybeCompact() {
    if (this.size > 1024 * 1024 && this.size > this.pendingBytes * 2) this.compact();
  }
  /** A fresh connection supplies the cell's authoritative cursor before its lease. */
  reconcile(sequence: number) {
    this.sequence(sequence);
    if (sequence < this.acknowledged) throw new OutboxError("runner_ack_regressed");
    this.acknowledge(sequence);
  }
  private readFrame(pointer: Pointer): RunnerEvent {
    const bytes = Buffer.alloc(pointer.length);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        this.fd,
        bytes,
        offset,
        bytes.length - offset,
        pointer.offset + offset,
      );
      if (!count) throw new OutboxError("runner_outbox_corrupt");
      offset += count;
    }
    const row = JSON.parse(bytes.toString("utf8")) as { t: string; hash: string; frame: unknown };
    const frame = this.frame(row.frame);
    if (row.t !== "event" || row.hash !== hash(JSON.stringify(frame)))
      throw new OutboxError("runner_outbox_corrupt");
    return frame;
  }
  *pending(after = this.acknowledged, limit = 8): Iterable<RunnerEvent> {
    this.ensureOpen();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
      throw new OutboxError("runner_outbox_invalid_batch");
    let count = 0;
    for (const [sequence, pointer] of this.index) {
      if (sequence <= after) continue;
      try {
        yield this.readFrame(pointer);
      } catch (error) {
        return this.fail(error);
      }
      if (++count >= limit) break;
    }
  }
  compact() {
    this.ensureOpen();
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd = -1;
    try {
      this.guard(this.header());
      fd = openSync(temporary, "wx", 0o600);
      const header = encoded(this.header());
      writeAll(fd, header);
      let offset = header.length;
      const index = new Map<number, Pointer>();
      for (const [sequence, pointer] of this.index) {
        const frame = this.readFrame(pointer);
        const bytes = encoded({ t: "event", hash: hash(JSON.stringify(frame)), frame });
        writeAll(fd, bytes);
        index.set(sequence, { offset, length: bytes.length });
        offset += bytes.length;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      renameSync(temporary, this.file);
      syncDirectory(path.dirname(this.file));
      this.close();
      this.fd = openSync(this.file, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
      this.size = offset;
      this.pendingBytes = offset - header.length;
      this.index.clear();
      for (const [sequence, pointer] of index) this.index.set(sequence, pointer);
    } catch (error) {
      if (fd >= 0) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch {}
      this.fail(error);
    }
  }
  close() {
    const fd = this.fd;
    this.fd = -1;
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  private fail(error: unknown): never {
    this.close();
    if (error instanceof OutboxError) throw error;
    throw new OutboxError(
      error && typeof error === "object" && "code" in error && error.code === "ENOSPC"
        ? "runner_outbox_full"
        : "runner_outbox_unavailable",
    );
  }
}
