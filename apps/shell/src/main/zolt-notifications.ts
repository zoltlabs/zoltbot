import { randomUUID } from "node:crypto";
import { mutedThreads, requestNotifies } from "@zoltbot/protocol";
import type { DaemonClient } from "../zolt/daemon-client";
import { desktopNotifications } from "./desktop/notifications";

export interface NotificationHost {
  /** The chat on screen, when the window has focus. Its requests don't notify. */
  focusedBot(): string | undefined;
  open(): void;
  failed(): void;
  setBadge(count: number): void;
}

/**
 * Notifies the person about agent requests (approvals, questions, routines) with Zoltbot's
 * planner, and keeps the dock badge at the number of requests waiting for them.
 */
export function connectNotifications(client: DaemonClient, host: NotificationHost) {
  const notifications = desktopNotifications({
    focusedThread: host.focusedBot,
    open: host.open,
    failed: host.failed,
    answer: async (id, version, choice) => {
      await client.call(
        "interaction.answer",
        {
          id,
          version,
          answer: {
            action: "accept",
            choice,
            by: { kind: "human", id: "local-owner" },
            at: new Date().toISOString(),
          },
        },
        randomUUID(),
      );
    },
  });
  let badge = -1;
  const updateBadge = () => {
    // A3: a muted chat's requests stay off the badge, except approvals.
    const muted = mutedThreads(client.rows("settings"));
    const count = client
      .rows("interaction")
      .filter((row) => row.state === "pending" && requestNotifies(row, muted)).length;
    if (count === badge) return;
    badge = count;
    host.setBadge(count);
  };
  const unsubscribe = client.onChange((change) => {
    if (change.kind === "reset") {
      notifications.snapshot(client.snapshot.entities);
      updateBadge();
      return;
    }
    if (change.kind !== "rows" || change.streamed) return;
    for (const row of change.rows) notifications.event(change.aggregateType, row);
    if (change.aggregateType === "interaction" || change.aggregateType === "settings")
      updateBadge();
  });
  if (client.status === "online") {
    notifications.snapshot(client.snapshot.entities);
    updateBadge();
  }
  return {
    tick: () => notifications.tick(),
    close() {
      unsubscribe();
      notifications.close();
    },
  };
}
