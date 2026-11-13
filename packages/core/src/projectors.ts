import { type DomainEvent, parseEvent } from "@zoltbot/protocol";

export type DomainState = Record<string, Record<string, unknown>[]>;
export function entityId(kind: string, entity: Record<string, unknown>): string {
  if (kind === "compareMember") return String(entity.threadId);
  if (kind === "taskResult") return `${entity.taskId}:${entity.revision}`;
  if (kind === "workflow") return `${entity.workflowId}:${entity.version}`;
  if (kind === "nativeSession") return `${entity.provider}:${entity.nativeId}`;
  return String(entity.id ?? entity.key ?? "");
}
const threadChildKinds = [
  "item",
  "turn",
  "session",
  "interaction",
  "wake",
  "orchestration",
  "contextPack",
  "compareMember",
] as const;
export function applyEvents(state: DomainState, events: readonly DomainEvent[]): DomainState {
  let next = { ...state };
  for (const raw of events) {
    const event = parseEvent(raw);
    if (event.type === "thread.deleted") {
      const updated = { ...next };
      updated.thread = (updated.thread ?? []).filter((row) => row.id !== event.aggregateId);
      for (const kind of threadChildKinds)
        if (updated[kind])
          updated[kind] = updated[kind].filter((row) => row.threadId !== event.aggregateId);
      if (updated.compare)
        updated.compare = updated.compare.map((row) => {
          if (row.summaryThreadId !== event.aggregateId) return row;
          const { summaryThreadId: _, ...rest } = row;
          return rest;
        });
      next = updated;
      continue;
    }
    const rows = next[event.aggregateType] ?? [];
    const body = event.payload as Record<string, unknown>;
    const remaining = rows.filter(
      (row) => entityId(event.aggregateType, row) !== event.aggregateId,
    );
    next = {
      ...next,
      [event.aggregateType]: [...remaining, body].sort((a, b) =>
        entityId(event.aggregateType, a).localeCompare(entityId(event.aggregateType, b)),
      ),
    };
  }
  return next;
}
