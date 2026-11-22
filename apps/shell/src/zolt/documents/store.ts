import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DOCUMENT_LIMITS,
  type DocumentComment,
  type DocumentVersionKind,
} from "../../shared/documents";
import { hashText } from "./files";

export interface StoredVersion {
  id: string;
  kind: Exclude<DocumentVersionKind, "commit">;
  author: string;
  at: string;
  hash: string;
}

export interface StoredReview {
  botId: string | null;
  botName: string;
  startedAt: string;
  changedAt?: string | null;
  baselineHash: string;
  /** The daemon task the agent works in; absent for reviews started from history. */
  taskId?: string | null;
}

/** What the shell remembers about one document. None of it goes into the repository. */
export interface DocumentState {
  path: string;
  /** The file's hash the last time the shell read or wrote it. */
  knownHash: string | null;
  comments: DocumentComment[];
  versions: StoredVersion[];
  review: StoredReview | null;
}

/** Saves by the person within this long of the last one replace it instead of adding a version. */
const SAVE_COALESCE_MS = 10 * 60 * 1000;

/**
 * Per-document state and the texts of earlier versions, kept as JSON and content-addressed text
 * files under the shell's data folder. Calls for one document run one at a time.
 */
export class DocumentStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly folder: string) {}

  private key(projectId: string, path: string) {
    return createHash("sha256").update(`${projectId}\0${path}`).digest("hex").slice(0, 32);
  }

  private projectFolder(projectId: string) {
    return join(this.folder, createHash("sha256").update(projectId).digest("hex").slice(0, 16));
  }

  /** Runs `work` with the document's state and saves whatever it leaves there. */
  async update<T>(
    projectId: string,
    path: string,
    work: (state: DocumentState) => Promise<T> | T,
  ): Promise<T> {
    const key = this.key(projectId, path);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const state = await this.read(projectId, path);
        const before = JSON.stringify(state);
        const held = referenced(state);
        let result: T;
        try {
          result = await work(state);
        } catch (error) {
          // What `work` learned before it failed, such as a version of a file changed on disk, stays.
          if (JSON.stringify(state) !== before) await this.write(projectId, state);
          throw error;
        }
        if (JSON.stringify(state) !== before) {
          await this.write(projectId, state);
          // Texts this document no longer points to go, unless another document shares them.
          const kept = referenced(state);
          for (const hash of held) if (!kept.has(hash)) await this.dropText(projectId, hash);
        }
        return result;
      });
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  async read(projectId: string, path: string): Promise<DocumentState> {
    try {
      const raw = JSON.parse(
        await readFile(
          join(this.projectFolder(projectId), `${this.key(projectId, path)}.json`),
          "utf8",
        ),
      ) as Partial<DocumentState>;
      return {
        path,
        knownHash: typeof raw.knownHash === "string" ? raw.knownHash : null,
        comments: Array.isArray(raw.comments) ? raw.comments : [],
        versions: Array.isArray(raw.versions) ? raw.versions : [],
        review: raw.review ?? null,
      };
    } catch {
      return { path, knownHash: null, comments: [], versions: [], review: null };
    }
  }

  /** Every document of a project the shell holds state for, for the list's badges. */
  async readMany(projectId: string, paths: string[]): Promise<Map<string, DocumentState>> {
    const states = await Promise.all(paths.map((path) => this.read(projectId, path)));
    return new Map(states.map((state) => [state.path, state]));
  }

  private async write(projectId: string, state: DocumentState) {
    const folder = this.projectFolder(projectId);
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${this.key(projectId, state.path)}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), "utf8");
    await rename(temporary, file);
  }

  async putText(projectId: string, text: string): Promise<string> {
    const hash = hashText(text);
    const folder = join(this.projectFolder(projectId), "texts");
    await mkdir(folder, { recursive: true });
    const file = join(folder, `${hash}.md`);
    try {
      await writeFile(file, text, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return hash;
  }

  private async dropText(projectId: string, hash: string) {
    const folder = this.projectFolder(projectId);
    const shared = await readdir(folder).catch(() => [] as string[]);
    for (const name of shared) {
      if (!name.endsWith(".json")) continue;
      try {
        const other = JSON.parse(await readFile(join(folder, name), "utf8")) as DocumentState;
        if (referenced(other).has(hash)) return;
      } catch {}
    }
    await unlink(join(folder, "texts", `${hash}.md`)).catch(() => undefined);
  }

  async getText(projectId: string, hash: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("That version isn't available.");
    try {
      return await readFile(join(this.projectFolder(projectId), "texts", `${hash}.md`), "utf8");
    } catch {
      throw new Error("That version isn't available anymore.");
    }
  }

  /** Keeps `text` as a version of the document, unless the newest version already holds it. */
  async addVersion(
    projectId: string,
    state: DocumentState,
    text: string,
    kind: StoredVersion["kind"],
    author: string,
  ): Promise<void> {
    const hash = await this.putText(projectId, text);
    const newest = state.versions.at(-1);
    const now = new Date();
    if (newest?.hash === hash) return;
    if (
      kind === "saved" &&
      newest?.kind === "saved" &&
      now.getTime() - Date.parse(newest.at) < SAVE_COALESCE_MS
    ) {
      newest.hash = hash;
      newest.at = now.toISOString();
      return;
    }
    state.versions.push({ id: randomUUID(), kind, author, at: now.toISOString(), hash });
    if (state.versions.length > DOCUMENT_LIMITS.versions)
      state.versions.splice(0, state.versions.length - DOCUMENT_LIMITS.versions);
  }
}

function referenced(state: DocumentState): Set<string> {
  const hashes = new Set(state.versions.map((version) => version.hash));
  if (state.knownHash) hashes.add(state.knownHash);
  if (state.review) hashes.add(state.review.baselineHash);
  return hashes;
}
