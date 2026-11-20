// S5: filtering what agents remember, for the Memory page. Pure, so it's tested without a renderer.
import type { MemoryEntry, MemoryProposal, MemoryView } from "../../shared/memory";

/** Filter value for entries that apply everywhere rather than to one project. */
export const EVERYWHERE = "everywhere";

export interface MemoryFilter {
  /** An agent's id, or "" for anyone. */
  agentId: string;
  /** A project's id, EVERYWHERE, or "" for any. */
  projectId: string;
  query: string;
}

type Item = MemoryEntry | MemoryProposal;

function matches(item: Item, filter: MemoryFilter): boolean {
  if (filter.agentId && item.agent?.id !== filter.agentId) return false;
  if (
    filter.projectId === EVERYWHERE
      ? item.projectId !== null
      : filter.projectId && item.projectId !== filter.projectId
  )
    return false;
  const query = filter.query.trim().toLowerCase();
  return !query || `${item.title}\n${item.body}`.toLowerCase().includes(query);
}

export function filterMemory<T extends Item>(items: readonly T[], filter: MemoryFilter): T[] {
  return items.filter((item) => matches(item, filter));
}

export interface MemoryOption {
  value: string;
  label: string;
}

/** The agents entries and proposals belong to, by name. */
export function agentOptions(view: MemoryView, unnamed: string): MemoryOption[] {
  const seen = new Map<string, string>();
  for (const item of [...view.entries, ...view.proposals])
    if (item.agent) seen.set(item.agent.id, item.agent.name || unnamed);
  return [...seen]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The projects entries belong to, by name, then entries that apply everywhere. */
export function projectOptions(
  view: MemoryView,
  everywhere: string,
  unnamed: string,
): MemoryOption[] {
  const seen = new Map<string, string>();
  let global = false;
  for (const item of [...view.entries, ...view.proposals]) {
    if (item.projectId) seen.set(item.projectId, item.projectName || unnamed);
    else global = true;
  }
  const options = [...seen]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return global ? [...options, { value: EVERYWHERE, label: everywhere }] : options;
}
