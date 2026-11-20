// S6: usage for the Usage page, kept current from main. Re-reads when usage or budgets change.
import { createSignal, onCleanup } from "solid-js";
import type { SpendView } from "../../shared/spend";
import { memoryError } from "./memory-store";
import { rangeDays, type SpendRange } from "./spend";

const EMPTY: SpendView = { rows: [], budgets: [], projects: [] };

export type SpendStore = ReturnType<typeof createSpendStore>;

/** A budget save; resolves to the reason it was refused, or null. */
export type SpendChange = Promise<string | null>;

export function createSpendStore(now: () => Date = () => new Date()) {
  const [range, setRange] = createSignal<SpendRange>("7d");
  const [view, setView] = createSignal<SpendView>(EMPTY);
  const [days, setDays] = createSignal<string[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let generation = 0;

  function refresh() {
    const current = ++generation;
    const { from, days: next } = rangeDays(range(), now());
    void window.openbot.spend
      .list({ from: from.toISOString() })
      .then((result) => {
        if (current !== generation) return;
        setView(result);
        setDays(next);
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
    if (event.type === "spend-changed" || event.type === "status") refresh();
  });
  onCleanup(off);
  refresh();

  return {
    view,
    /** Each local day in the range, oldest first. */
    days,
    range,
    setRange(next: SpendRange) {
      setRange(next);
      refresh();
    },
    loaded,
    error,
    refresh,
    /** Saves a project's spending cap; resolves to the reason it was refused, or null. */
    async setBudget(projectId: string, usd: number): SpendChange {
      try {
        await window.openbot.spend.setBudget({ projectId, usd });
        return null;
      } catch (failure) {
        return memoryError(failure);
      } finally {
        refresh();
      }
    },
  };
}
