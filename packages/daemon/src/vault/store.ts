// V1: the vault's records, kept in a private file in the daemon's data folder rather than the
// event-sourced store, so usernames and sites don't travel to the phone or the cloud with
// snapshots. Each record names its keychain reference; no value is ever written here (I7).
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { Value } from "@sinclair/typebox/value";
import { MAX_VAULT_ENTRIES, type VaultEntry, VaultEntrySchema } from "@zoltbot/protocol";
import { isSecretReference } from "../secrets.js";

export interface VaultRecord extends VaultEntry {
  /** `keychain:zoltbot:<uuid>`. Never leaves the daemon. Absent for a manager's login (V3). */
  reference?: string;
}

/** The record without its reference, as clients see it. */
export function publicEntry(record: VaultRecord): VaultEntry {
  const { reference: _, ...entry } = record;
  return entry;
}

function readFile(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; entries?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error("vault_file_invalid");
  return raw.entries;
}

function asRecord(item: unknown): VaultRecord | undefined {
  if (!item || typeof item !== "object") return undefined;
  const { reference, ...entry } = item as Record<string, unknown>;
  if (!Value.Check(VaultEntrySchema, entry)) return undefined;
  // Each record has exactly one home for its value: the keychain, or a password manager.
  if (entry.source !== undefined)
    return reference === undefined ? (entry as VaultEntry) : undefined;
  if (typeof reference !== "string" || !isSecretReference(reference)) return undefined;
  return { ...(entry as VaultEntry), reference };
}

/** One writer at a time; each change rewrites the file through a rename. */
export class VaultRecords {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "vault.json");
  }
  list(): VaultRecord[] {
    return readFile(this.file).flatMap((item) => asRecord(item) ?? []);
  }
  get(id: string): VaultRecord | undefined {
    return this.list().find((record) => record.id === id);
  }
  /** Runs `change` on the current records and saves what it returns. */
  change<T>(change: (records: VaultRecord[]) => { records: VaultRecord[]; result: T }): Promise<T> {
    const run = this.queue.then(() => {
      const stored = readFile(this.file);
      // Rows this version can't read are kept as they are, never dropped with their keychain item.
      const unread = stored.filter((item) => !asRecord(item));
      const next = change(stored.flatMap((item) => asRecord(item) ?? []));
      const entries = [...next.records, ...unread];
      if (entries.length > MAX_VAULT_ENTRIES) throw new Error("vault_full");
      const temporary = `${this.file}.${randomUUID()}`;
      const handle = openSync(temporary, "wx", 0o600);
      try {
        writeSync(handle, JSON.stringify({ version: 1, entries }));
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      renameSync(temporary, this.file);
      return next.result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
