import { type DomainEvent, parseEvent } from "@zoltbot/protocol";

export type DomainState = Record<string, Record<string, unknown>[]>;
export function entityId(kind: string, entity: Record<string, unknown>): string {
  if (kind === "compareMember") return String(entity.threadId);
  if (kind === "taskResult") return `${entity.taskId}:${entity.revision}`;
  if (kind === "workflow") return `${entity.workflowId}:${entity.version}`;
  if (kind === "nativeSession") return `${entity.provider}:${entity.nativeId}`;
  return String(entity.id ?? entity.key ?? "");
}
export function applyEvents(state: DomainState, events: readonly DomainEvent[]): DomainState {
  let next = { ...state };
  for (const raw of events) {
    const event = parseEvent(raw);
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
