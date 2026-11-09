import type { Interaction, RoutineOccurrence } from "@zoltbot/protocol";

/** Requests the main agent ranked `later` never notify. */
export { laterIds } from "./chief/queue.js";

export type NotificationChange =
  | { action: "withdraw"; key: string }
  | {
      action: "show";
      key: string;
      interactionId: string;
      threadId: string;
      title: string;
      body: string;
      silent: boolean;
    };
export interface NotificationContext {
  focusedThreadId: string | undefined;
  idle: boolean;
  previews: boolean;
  enabled: boolean;
  quiet?: boolean;
  agentNames: ReadonlyMap<string, string>;
}
function reminderSlot(age: number) {
  if (age < 5 * 60000) return 0;
  if (age < 30 * 60000) return 1;
  return 2 + Math.floor((age - 30 * 60000) / (60 * 60000));
}
/** Ephemeral OS delivery state. The durable interaction remains the source of truth. */
export class NotificationPlanner {
  private readonly slots = new Map<string, number>();
  private readonly visible = new Set<string>();
  private readonly routineDelivered = new Set<string>();
  private readonly routineVisible = new Set<string>();
  reconcile(
    requests: readonly Interaction[],
    context: NotificationContext,
    now: number,
  ): NotificationChange[] {
    if (!Number.isFinite(now)) return [];
    const pending = new Map(
      requests.filter((row) => row.state === "pending").map((row) => [row.id, row]),
    );
    const changes: NotificationChange[] = [];
    for (const id of this.visible)
      if (
        !pending.has(id) ||
        !context.enabled ||
        context.quiet === true ||
        pending.get(id)?.threadId === context.focusedThreadId
      ) {
        changes.push({ action: "withdraw", key: `interaction:${id}` });
        this.visible.delete(id);
      }
    for (const id of this.slots.keys()) if (!pending.has(id)) this.slots.delete(id);
    for (const row of pending.values()) {
      const created = Date.parse(row.createdAt);
      if (!Number.isFinite(created)) continue;
      const slot = reminderSlot(Math.max(0, now - created));
      const previous = this.slots.get(row.id);
      if (!context.enabled || row.threadId === context.focusedThreadId) {
        this.slots.set(row.id, Math.max(previous ?? -1, slot));
        continue;
      }
      if (context.quiet) continue;
      if (previous !== undefined && (slot <= previous || !context.idle)) continue;
      const privateRequest = row.items.some((item) => item.secret);
      const body = privateRequest
        ? "A private answer is requested. Open Zoltbot to respond."
        : context.previews
          ? row.items
              .map((item) => item.prompt)
              .join(" ")
              .slice(0, 160)
          : "Open Zoltbot to review this request.";
      const suffix =
        row.type === "approval"
          ? "needs approval"
          : row.type === "plan"
            ? "needs plan review"
            : "needs an answer";
      changes.push({
        action: "show",
        key: `interaction:${row.id}`,
        interactionId: row.id,
        threadId: row.threadId,
        title: `${context.agentNames.get(row.agentId) ?? "An agent"} ${suffix}`,
        body,
        silent: row.urgency === "background",
      });
      this.slots.set(row.id, slot);
      this.visible.add(row.id);
    }
    return changes;
  }
  /** Routine results use the same preferences, focus suppression and quiet windows. */
  reconcileRoutines(
    runs: readonly RoutineOccurrence[],
    context: NotificationContext,
  ): NotificationChange[] {
    const changes: NotificationChange[] = [];
    for (const run of runs) {
      const key = `routine:${run.id}`;
      if (!run.taskId || !["completed", "expired"].includes(run.status)) continue;
      const threadId = `${run.taskId}:thread`;
      const wanted = run.notify === "always" || run.outcome !== "nothing";
      if (
        this.routineVisible.has(key) &&
        (!context.enabled || context.quiet || context.focusedThreadId === threadId)
      ) {
        changes.push({ action: "withdraw", key });
        this.routineVisible.delete(key);
      }
      if (!wanted || this.routineDelivered.has(key)) continue;
      if (!context.enabled || context.focusedThreadId === threadId) {
        this.routineDelivered.add(key);
        continue;
      }
      if (context.quiet) continue;
      changes.push({
        action: "show",
        key,
        interactionId: key,
        threadId,
        title: run.status === "expired" ? "Routine expired" : "Routine finished",
        body:
          run.outcome === "nothing" ? "No action needed." : "Open Zoltbot to review the result.",
        silent: false,
      });
      this.routineDelivered.add(key);
      this.routineVisible.add(key);
    }
    return changes;
  }
  reset(): NotificationChange[] {
    const changes: NotificationChange[] = [...this.visible].map((id) => ({
      action: "withdraw",
      key: `interaction:${id}`,
    }));
    for (const key of this.routineVisible) changes.push({ action: "withdraw", key });
    this.routineVisible.clear();
    this.visible.clear();
    this.slots.clear();
    return changes;
  }
}

/** Clock windows are half open. Equal start and end is an empty window. */
export function inQuietHours(value: unknown, now: number): boolean {
  if (!Number.isFinite(now) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  const setting = value as Record<string, unknown>;
  if (
    setting.enabled !== true ||
    typeof setting.start !== "string" ||
    typeof setting.end !== "string" ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(setting.start) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(setting.end) ||
    (setting.timeZone !== undefined && typeof setting.timeZone !== "string")
  )
    return false;
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
  const start = minutes(setting.start),
    end = minutes(setting.end);
  if (start === end) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      ...(typeof setting.timeZone === "string" ? { timeZone: setting.timeZone } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(now));
    const minute =
      Number(parts.find((part) => part.type === "hour")?.value) * 60 +
      Number(parts.find((part) => part.type === "minute")?.value);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  } catch {
    return false;
  }
}

export function notificationChoices(request: Interaction): ("allow_once" | "reject_once")[] {
  if (
    request.state !== "pending" ||
    request.type !== "approval" ||
    request.items.length !== 1 ||
    request.items.some((item) => item.secret) ||
    request.context?.diffs?.length ||
    request.context?.deliverable
  )
    return [];
  const item = request.items[0];
  if (!item || item.schema !== undefined) return [];
  return (["allow_once", "reject_once"] as const).filter((id) =>
    item.choices?.some((choice) => choice.id === id),
  );
}
