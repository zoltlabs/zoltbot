import { routineShouldNotify } from "@zoltbot/core";
import type { DomainEvent, Interaction } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { chiefKeys } from "./chief/identity.js";
import { notifyCode } from "./chief/notify.js";
import type { DeviceBook } from "./devices.js";
import { inQuietHours, laterIds, notificationChoices } from "./notifications.js";
import type { RelayLink } from "./relay-link.js";

// Pushes to paired phones (D124). A push carries only a kind and a count; the phone fetches
// the details over the sealed link when the person opens it. When the only new request in a
// batch is a simple approval, the push also names its id and version (never its text) so the
// phone can offer Allow once and Reject from the notification.

const cap = (count: number) => Math.max(0, Math.min(999, count));

export function pushNotifier(options: {
  store: Store;
  devices: DeviceBook;
  link(): RelayLink | undefined;
  delayMs?: number;
}) {
  const taskStates = new Map<string, string>();
  for (const task of options.store.snapshot(["task"]).task ?? [])
    taskStates.set(String(task.id), String(task.state));
  let needsYou = false;
  /** A task went to review in this batch, which always needs you. */
  let reviewed = false;
  let finished = 0;
  let created: string[] = [];
  /** Threads the main agent sent a notice from in this batch. */
  let notices: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    timer = undefined;
    const preferences = options.store.record("settings", "notifications")?.value as
      | { enabled?: boolean; quietHours?: unknown }
      | undefined;
    if (preferences?.enabled === false) {
      needsYou = false;
      reviewed = false;
      finished = 0;
      created = [];
      notices = [];
      return;
    }
    if (inQuietHours(preferences?.quietHours, Date.now())) {
      timer = setTimeout(flush, 30_000);
      timer.unref?.();
      return;
    }
    const link = options.link();
    const devices = options.devices.paired();
    if (link?.status !== "online" || !devices.length) {
      needsYou = false;
      reviewed = false;
      finished = 0;
      created = [];
      notices = [];
      return;
    }
    const state = options.store.snapshot(["interaction", "task", "settings"]);
    // What the main agent ranked for later waits in Needs you without a push.
    const later = laterIds(state.settings?.find((row) => row.key === chiefKeys.queue)?.value);
    const pending = (state.interaction ?? []).filter(
      (row) => row.state === "pending" && !later.has(String(row.id)),
    );
    // Only new requests ranked for later: nothing worth a push.
    if (needsYou && !reviewed && created.length && created.every((id) => later.has(id)))
      needsYou = false;
    const waiting =
      pending.length +
      (state.task ?? []).filter((row) => row.state === "review" && !row.routineOccurrenceId).length;
    const action = needsYou
      ? approvalAction(
          pending,
          created.filter((id) => !later.has(id)),
        )
      : undefined;
    // Each phone can turn off its own pushes (mobile.<deviceId>.notifyNeedsYou / notifyResults /
    // notifyZolt).
    const off = (deviceId: string, field: string) =>
      state.settings?.find((row) => row.key === `mobile.${deviceId}.${field}`)?.value === false;
    // A tap opens the chat of the newest notice.
    const opened = notices.at(-1);
    for (const device of devices) {
      if (needsYou && !off(device.id, "notifyNeedsYou"))
        link.send({
          t: "push",
          deviceId: device.id,
          kind: "needs_you",
          count: cap(waiting),
          ...action,
        });
      if (finished && !off(device.id, "notifyResults"))
        link.send({ t: "push", deviceId: device.id, kind: "task_done", count: cap(finished) });
      // A relay that never announced notices would refuse the frame and count it against us.
      if (notices.length && link.delivers("zolt") && !off(device.id, "notifyZolt"))
        link.send({
          t: "push",
          deviceId: device.id,
          kind: "zolt",
          count: cap(notices.length),
          ...(opaque(opened) ? { threadId: opened } : {}),
        });
    }
    needsYou = false;
    reviewed = false;
    finished = 0;
    created = [];
    notices = [];
  }

  return {
    observe(events: readonly DomainEvent[]) {
      let changed = false;
      for (const event of events) {
        const payload = event.payload as {
          id?: unknown;
          state?: unknown;
          routineOccurrenceId?: unknown;
        };
        if (event.aggregateType === "routineOccurrence") {
          const occurrence = event.payload as import("@zoltbot/protocol").RoutineOccurrence;
          if (
            ["completed", "expired"].includes(occurrence.status) &&
            routineShouldNotify(occurrence.notify, occurrence.outcome)
          ) {
            finished += 1;
            changed = true;
          }
        }
        if (event.type === "item.created") {
          const item = event.payload as { kind?: unknown; threadId?: unknown; body?: unknown };
          if (
            item.kind === "note" &&
            (item.body as { code?: unknown } | undefined)?.code === notifyCode &&
            typeof item.threadId === "string"
          ) {
            notices.push(item.threadId);
            changed = true;
          }
        }
        if (event.type === "interaction.created" && payload.state === "pending") {
          if (typeof payload.id === "string") created.push(payload.id);
          needsYou = true;
          changed = true;
        }
        if (event.aggregateType === "task" && typeof payload.id === "string") {
          const before = taskStates.get(payload.id);
          const after = String(payload.state);
          taskStates.set(payload.id, after);
          if (before === after || payload.routineOccurrenceId) continue;
          if (after === "review") {
            needsYou = true;
            reviewed = true;
            changed = true;
          }
          if (after === "failed") {
            finished += 1;
            changed = true;
          }
        }
      }
      if (changed && !timer) {
        timer = setTimeout(flush, options.delayMs ?? 3000);
        timer.unref?.();
      }
    },
    close() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** A record id the push frame may carry. */
const opaque = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);

/** Actionable only for exactly one new, still pending approval that offers both choices. */
function approvalAction(rows: readonly Record<string, unknown>[], created: readonly string[]) {
  if (created.length !== 1) return undefined;
  const row = rows.find((value) => value.id === created[0]);
  if (!row || typeof row.version !== "number" || !opaque(row.id) || !opaque(row.threadId))
    return undefined;
  const choices = notificationChoices(row as unknown as Interaction);
  if (!choices.includes("allow_once") || !choices.includes("reject_once")) return undefined;
  return {
    category: "approval" as const,
    interactionId: String(row.id),
    threadId: String(row.threadId),
    version: row.version,
  };
}
