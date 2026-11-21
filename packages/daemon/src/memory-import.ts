// M4: bring memory from ChatGPT, Claude or Gemini. Saved memories in the export become proposals
// at once; conversations are read in short batches by the owner's cheapest model, with no tools,
// and every fact it finds waits in Needs review. Nothing is saved without the owner's OK.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  type ExportFiles,
  exportFiles,
  extractInstructions,
  type ImportBatch,
  type ImportedExport,
  type ImportedFact,
  type ImportSource,
  importBatches,
  importBatchId,
  memoriesAsFacts,
  parseExport,
  parseExtracted,
  proposeImported,
} from "@zoltbot/knowledge";
import type { DomainEvent, MemoryImportStatus } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { InferenceAdapter } from "./quick-chat/providers.js";

const run = promisify(execFile);
const actor = { kind: "system" as const, id: "memory-import" };
const SOURCES: readonly ImportSource[] = ["chatgpt", "claude", "gemini"];
/** Exports are large; anything bigger is refused before it is read. */
export const importFileLimit = 2 * 1024 ** 3;
/** One file inside the export, and all of them together. Parsing larger text stalls the daemon. */
export const importReadLimits = { file: 200 * 1024 ** 2, total: 300 * 1024 ** 2, files: 8 };
const TOO_LARGE = "import_file_too_large: this export is too large to read. Export less history.";
// `unzip -Zl` lines: permissions, version, system, size, type, compressed size, method, date,
// time, then the name.
const LISTED = /^\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s(.+)$/;

/** The export's JSON files: a bare .json file, or the few files `source` needs from a ZIP. */
export async function readExport(path: string, source: ImportSource): Promise<ExportFiles> {
  if (!isAbsolute(path)) throw new Error("import_file_missing: pick the export file again.");
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error("import_file_missing: pick the export file again.");
  if (info.size > importFileLimit) throw new Error("import_file_too_large: the file is over 2 GB.");
  const extension = extname(path).toLowerCase();
  if (extension === ".json") {
    if (info.size > importReadLimits.file) throw new Error(TOO_LARGE);
    return new Map([[basename(path), await readFile(path, "utf8")]]);
  }
  if (extension !== ".zip") throw new Error("import_file_type: pick the .zip or .json export.");
  let listing: string;
  try {
    listing = (await run("unzip", ["-Zl", path], { maxBuffer: 64 * 1024 ** 2 })).stdout;
  } catch {
    throw new Error("import_file_unreadable: this ZIP couldn't be opened.");
  }
  const entries = listing
    .split("\n")
    .map((line) => LISTED.exec(line))
    .flatMap((match) => (match ? [{ size: Number(match[1]), name: match[2] ?? "" }] : []))
    .filter((entry) => exportFiles[source].test(entry.name))
    // unzip reads these characters as patterns or options; real exports don't use them.
    .filter((entry) => !/^-|[[\]*?\\]/.test(entry.name));
  if (entries.length > importReadLimits.files) throw new Error(TOO_LARGE);
  let total = 0;
  for (const entry of entries) {
    if (entry.size > importReadLimits.file) throw new Error(TOO_LARGE);
    total += entry.size;
  }
  if (total > importReadLimits.total) throw new Error(TOO_LARGE);
  const files = new Map<string, string>();
  for (const entry of entries) {
    try {
      const { stdout } = await run("unzip", ["-p", path, entry.name], {
        maxBuffer: importReadLimits.file,
        encoding: "utf8",
      });
      files.set(entry.name, stdout);
    } catch {
      throw new Error("import_file_unreadable: this ZIP couldn't be opened.");
    }
  }
  return files;
}

function sourceOf(value: unknown): ImportSource {
  if (!SOURCES.includes(value as ImportSource)) throw new Error("invalid_import_source");
  return value as ImportSource;
}

export interface MemoryImportHost {
  store: Store;
  publish(events: DomainEvent[]): void;
  router(): Promise<{ adapter: InferenceAdapter; model: string } | undefined>;
  /** True when the text holds a saved secret; such facts are dropped. */
  containsSecret(text: string): Promise<boolean>;
  read?: typeof readExport;
  onError?(code: string): void;
}

type Prepared = { parsed: ImportedExport; batches: ImportBatch[] };

export function memoryImportApi(host: MemoryImportHost) {
  const jobs = new Map<string, MemoryImportStatus>();
  const controller = new AbortController();
  const read = host.read ?? readExport;
  // Preview and start read the same file; the parsed export is kept for the start that follows.
  let cached: { key: string; value: Prepared } | undefined;

  async function prepare(source: ImportSource, path: string): Promise<Prepared> {
    const info = await stat(path).catch(() => undefined);
    const key = `${source}\n${path}\n${info?.size}\n${info?.mtimeMs}`;
    if (info && cached?.key === key) return cached.value;
    const parsed = parseExport(source, await read(path, source));
    // Batches already read in an earlier import of this export are skipped.
    const batches = importBatches(parsed.conversations).filter(
      (batch) => !host.store.receipt(importBatchId(source, batch)),
    );
    const value = { parsed, batches };
    if (info) cached = { key, value };
    return value;
  }

  async function propose(source: ImportSource, facts: ImportedFact[], commandId: string) {
    const clean: ImportedFact[] = [];
    for (const fact of facts)
      if (!(await host.containsSecret(`${fact.title}\n${fact.body}`))) clean.push(fact);
    if (!clean.length) return 0;
    const before = host.store.lastSeq();
    const { result } = host.store.dispatch(commandId, (state) =>
      proposeImported(state, source, clean, { commandId, at: new Date().toISOString(), actor }),
    );
    host.publish(host.store.eventsSince(before));
    return (result as { proposed: number }).proposed;
  }

  /** One conversation id for the whole import, so a coding tool keeps one session, not thirty. */
  async function infer(
    connection: { adapter: InferenceAdapter; model: string },
    batch: string,
    jobId: string,
  ) {
    const limit = new AbortController();
    const bounded = AbortSignal.any([controller.signal, limit.signal, AbortSignal.timeout(60_000)]);
    let output = "";
    await connection.adapter.stream({
      model: connection.model,
      conversationId: `memory-${jobId}`,
      instructions: extractInstructions,
      turns: [{ role: "user", text: batch }],
      signal: bounded,
      onText(delta) {
        output += delta;
        if (output.length > 16_000) limit.abort(new Error("import_output_limit"));
      },
    });
    bounded.throwIfAborted();
    return output;
  }

  async function extract(job: MemoryImportStatus, source: ImportSource, batches: ImportBatch[]) {
    const connection = await host.router();
    if (!connection) {
      job.state = "failed";
      job.error = "Connect a model to read conversations.";
      return;
    }
    let failed = 0;
    for (const batch of batches) {
      if (controller.signal.aborted) break;
      const batchId = importBatchId(source, batch);
      try {
        const text = await infer(connection, batch.text, job.id);
        job.proposed += await propose(source, parseExtracted(text), `${job.id}:${batchId}`);
        host.store.dispatch(batchId, () => ({ events: [], result: { read: true } }));
      } catch {
        if (controller.signal.aborted) break;
        failed++;
        host.onError?.("memory_import_batch_failed");
      }
      job.read += batch.conversations;
    }
    if (controller.signal.aborted) {
      job.state = "failed";
      job.error = "The import stopped when Zoltbot closed.";
    } else if (failed === batches.length) {
      job.state = "failed";
      job.error = "Your model didn’t answer. Check it’s signed in, then import again.";
    } else job.state = "done";
  }

  async function api(method: string, params: Record<string, unknown>, commandId?: string) {
    if (method === "memory.import.status") {
      const job = jobs.get(String(params.id));
      if (!job) throw new Error("import_not_found: this import is no longer running.");
      return { ...job };
    }
    if (method !== "memory.import.preview" && method !== "memory.import.start") return undefined;
    const source = sourceOf(params.source);
    const { parsed, batches } = await prepare(source, String(params.path));
    const conversations = batches.reduce((sum, batch) => sum + batch.conversations, 0);
    if (method === "memory.import.preview")
      return { memories: parsed.memories.length, conversations };
    if (!commandId) throw new Error("command_id_required");
    const id = `import-${createHash("sha256").update(commandId).digest("hex").slice(0, 16)}`;
    const existing = jobs.get(id);
    if (existing) return { ...existing };
    const job: MemoryImportStatus = {
      id,
      state: batches.length ? "reading" : "done",
      conversations,
      read: 0,
      proposed: await propose(source, memoriesAsFacts(parsed), `${id}:memories`),
    };
    jobs.set(id, job);
    cached = undefined;
    if (batches.length)
      void extract(job, source, batches).catch(() => {
        job.state = "failed";
        job.error = "Couldn’t finish reading the conversations.";
      });
    return { ...job };
  }

  return {
    api,
    /** Stops reading; facts already found stay in Needs review. */
    close() {
      controller.abort();
    },
  };
}

export type MemoryImportApi = ReturnType<typeof memoryImportApi>;
