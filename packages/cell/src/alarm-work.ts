import { timeoutInteraction } from "@zoltbot/core";
import type { Store } from "@zoltbot/store/portable";

/** Each invocation commits a bounded rebuild step; the cursor survives object eviction. */
export async function rebuildAlarm(store: Store, storage: DurableObjectStorage): Promise<boolean> {
  const requested = await storage.get<boolean>("cell:rebuild");
  const progress = store.rebuildProgress();
  if (!requested && !progress) return false;
  const next = store.rebuildStep(progress?.cursor, 100);
  if (next === null) await storage.delete("cell:rebuild");
  else await storage.setAlarm(Date.now() + 1);
  return true;
}
export function interactionAlarms(store: Store, now = Date.now()): boolean {
  const pending = store.database
    .prepare("SELECT id,task_id,thread_id FROM interactions WHERE state='pending'")
    .all() as { id: string; task_id: string | null; thread_id: string }[];
  let outstanding = false;
  for (const row of pending) {
    const interaction = store.record("interaction", row.id);
    const timeout = interaction?.timeout as { seconds?: number } | undefined;
    if (!timeout?.seconds) continue;
    outstanding = true;
    if (Date.parse(String(interaction?.createdAt)) + timeout.seconds * 1000 > now) continue;
    const projectId = store.record("thread", row.thread_id)?.projectId;
    if (!row.task_id && typeof projectId !== "string") continue;
    const commandId = `timeout:${row.id}:${interaction?.version}`;
    store.dispatch(
      commandId,
      (state) =>
        timeoutInteraction(state, row.id, {
          commandId,
          at: new Date(now).toISOString(),
          actor: { kind: "system", id: "cell" },
        }),
      {
        scope: row.task_id ? { taskId: row.task_id } : { projectId: String(projectId) },
        kinds: ["interaction", "task", "turn", "rule"],
      },
    );
  }
  return outstanding;
}
