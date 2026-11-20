// S5: what agents remember, kept current from main. Re-reads after each memory change.
import { createSignal, onCleanup } from "solid-js";
import type { MemoryEntry, MemoryView } from "../../shared/memory";

const EMPTY: MemoryView = { entries: [], proposals: [] };

/** An IPC error's own message, without Electron's prefix. */
export const memoryError = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
    : String(error);

export type MemoryStore = ReturnType<typeof createMemoryStore>;

/** A change to memory; resolves to the reason it was refused, or null. */
export type MemoryChange = () => Promise<string | null>;

/** Rows that didn't change keep their object, so an open edit or its error survives a re-read. */
function reuse<T extends { id: string }>(previous: readonly T[], next: T[]): T[] {
  const old = new Map(previous.map((row) => [row.id, row]));
  return next.map((row) => {
    const before = old.get(row.id);
    return before && JSON.stringify(before) === JSON.stringify(row) ? before : row;
  });
}

function keepUnchanged(previous: MemoryView, next: MemoryView): MemoryView {
  return {
    entries: reuse(previous.entries, next.entries),
    proposals: reuse(previous.proposals, next.proposals),
  };
}

export function createMemoryStore() {
  const [view, setView] = createSignal<MemoryView>(EMPTY);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let generation = 0;
  const api = () => window.openbot.memory;

  function refresh() {
    const current = ++generation;
    void api()
      .list()
      .then((next) => {
        if (current !== generation) return;
        setView((previous) => keepUnchanged(previous, next));
        setError(null);
      })
      .catch((failure) => {
        if (current === generation) setError(memoryError(failure));
      })
      .finally(() => {
        if (current === generation) setLoaded(true);
      });
  }

  const off = window.openbot.agent.onEvent((event) => {
    if (event.type === "memory-changed" || event.type === "status") refresh();
  });
  onCleanup(off);
  refresh();

  /** Runs a change, then re-reads; a refusal comes back as its message. */
  async function change(run: () => Promise<void>): Promise<string | null> {
    try {
      await run();
      return null;
    } catch (error) {
      return memoryError(error);
    } finally {
      refresh();
    }
  }

  return {
    view,
    loaded,
    /** Why the last read failed, or null. */
    error,
    proposals: () => view().proposals,
    refresh,
    revisions: (id: string): Promise<MemoryEntry[]> => api().revisions(id),
    save: (entry: MemoryEntry, title: string, body: string) =>
      change(() => api().save({ id: entry.id, title, body, revision: entry.revision })),
    /** Restores an older revision's text as a new revision. */
    revert: (entry: MemoryEntry, to: MemoryEntry) =>
      change(() =>
        api().save({ id: entry.id, title: to.title, body: to.body, revision: entry.revision }),
      ),
    archive: (entry: MemoryEntry) =>
      change(() => api().archive({ id: entry.id, revision: entry.revision })),
    decide: (id: string, decision: "accept" | "reject") =>
      change(() => api().decide({ id, decision })),
  };
}
