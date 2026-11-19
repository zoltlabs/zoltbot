import {
  inQuietHours,
  laterIds,
  NotificationPlanner,
  notificationChoices,
} from "@zoltbot/daemon/notifications";
import {
  type Interaction,
  InteractionSchema,
  parse,
  type RoutineOccurrence,
  RoutineOccurrenceSchema,
} from "@zoltbot/protocol";
import { Notification, powerMonitor } from "electron";

export function desktopNotifications(host: {
  focusedThread(): string | undefined;
  open(): void;
  failed(): void;
  answer?(id: string, version: number, choice: "allow_once" | "reject_once"): Promise<void>;
}) {
  const planner = new NotificationPlanner();
  const requests = new Map<string, Interaction>();
  const routines = new Map<string, RoutineOccurrence>();
  const notices = new Map<string, { id: string; threadId: string; text: string }>();
  let chiefName = "Zolt";
  const names = new Map<string, string>();
  const native = new Map<string, Notification>();
  let previews = false;
  let enabled = true;
  let quietHours: unknown;
  let later = new Set<string>();
  function tick() {
    const now = Date.now();
    const changes = planner.reconcile(
      // What the main agent ranked for later waits in Needs you without a notification.
      [...requests.values()].filter((request) => !later.has(request.id)),
      {
        focusedThreadId: host.focusedThread(),
        idle: powerMonitor.getSystemIdleTime() >= 60,
        previews,
        enabled,
        quiet: inQuietHours(quietHours, now),
        agentNames: names,
      },
      now,
    );
    changes.push(
      ...planner.reconcileRoutines([...routines.values()], {
        focusedThreadId: host.focusedThread(),
        idle: powerMonitor.getSystemIdleTime() >= 60,
        previews,
        enabled,
        quiet: inQuietHours(quietHours, now),
        agentNames: names,
      }),
    );
    changes.push(
      ...planner.reconcileNotices([...notices.values()], {
        focusedThreadId: host.focusedThread(),
        idle: powerMonitor.getSystemIdleTime() >= 60,
        previews,
        enabled,
        quiet: inQuietHours(quietHours, now),
        agentNames: names,
        chiefName,
      }),
    );
    for (const change of changes) {
      native.get(change.key)?.close();
      native.delete(change.key);
      if (change.action === "withdraw" || !Notification.isSupported()) continue;
      try {
        const request = requests.get(change.interactionId);
        const choices = host.answer && request ? notificationChoices(request) : [];
        const notice = new Notification({
          title: change.title,
          body: change.body,
          silent: change.silent,
          actions: [
            { type: "button", text: "Open" },
            ...choices.map((choice) => ({
              type: "button" as const,
              text: choice === "allow_once" ? "Allow once" : "Reject",
            })),
          ],
        });
        native.set(change.key, notice);
        notice.on("click", host.open);
        let acted = false;
        notice.on("action", (_event, index) => {
          if (index === 0) {
            host.open();
            return;
          }
          const choice = choices[index - 1];
          if (acted || !choice || !request || !host.answer) return;
          acted = true;
          void host.answer(request.id, request.version, choice).catch(() => {
            host.failed();
            host.open();
          });
        });
        notice.on("failed", host.failed);
        notice.on("close", () => {
          if (native.get(change.key) === notice) native.delete(change.key);
        });
        notice.show();
      } catch {
        host.failed();
      }
    }
  }
  function apply(kind: string, value: Record<string, unknown>) {
    if (kind === "routineOccurrence") {
      const row = parse(RoutineOccurrenceSchema, value);
      routines.set(row.id, row);
    }
    if (kind === "interaction") {
      const row = parse(InteractionSchema, value);
      requests.set(row.id, row);
    }
    if (kind === "agent" && typeof value.id === "string" && typeof value.name === "string")
      names.set(value.id, value.name);
    if (kind === "settings" && value.key === "chief.queue") later = laterIds(value.value);
    if (kind === "settings" && value.key === "chief.name")
      chiefName =
        typeof value.value === "string" && value.value.trim() ? value.value.trim() : "Zolt";
    // Only live events reach here, so a notice from before the app started never shows.
    if (
      kind === "item" &&
      value.kind === "note" &&
      (value.body as { code?: unknown } | undefined)?.code === "chief_notify" &&
      typeof value.id === "string" &&
      typeof value.threadId === "string"
    )
      notices.set(value.id, {
        id: value.id,
        threadId: value.threadId,
        text: String((value.body as { text?: unknown }).text ?? ""),
      });
    if (kind === "settings" && value.key === "notifications") {
      const setting = value.value;
      if (setting && typeof setting === "object" && !Array.isArray(setting)) {
        const options = setting as Record<string, unknown>;
        previews = options.previews === true;
        enabled = options.enabled !== false;
        quietHours = options.quietHours;
      } else {
        previews = false;
        enabled = true;
        quietHours = undefined;
      }
    }
  }
  const timer = setInterval(tick, 30000);
  timer.unref();
  return {
    tick,
    snapshot(entities: Record<string, Record<string, unknown>[]>) {
      requests.clear();
      routines.clear();
      names.clear();
      chiefName = "Zolt";
      previews = false;
      enabled = true;
      quietHours = undefined;
      later = new Set();
      for (const kind of ["agent", "settings", "interaction", "routineOccurrence"])
        for (const row of entities[kind] ?? []) apply(kind, row);
      tick();
    },
    event(kind: string, payload: Record<string, unknown>) {
      apply(kind, payload);
      tick();
    },
    close() {
      clearInterval(timer);
      planner.reset();
      for (const notice of native.values()) notice.close();
      native.clear();
      requests.clear();
      routines.clear();
      notices.clear();
      names.clear();
    },
  };
}
