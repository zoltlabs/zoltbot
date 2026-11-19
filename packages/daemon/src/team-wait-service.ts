import {
  type DomainState,
  readTeamWait,
  teamWaitDoneStates,
  teamWaitTargets,
  wakeTeamWait,
} from "@zoltbot/core";
import { parse, type TeamWait, TeamWaitSchema } from "@zoltbot/protocol";
import type { RuntimeContext } from "./api.js";

const prefix = "team.wait.";

function waits(state: DomainState): TeamWait[] {
  const rows: TeamWait[] = [];
  for (const row of state.settings ?? []) {
    if (!String(row.key).startsWith(prefix)) continue;
    try {
      rows.push(parse(TeamWaitSchema, row.value));
    } catch {}
  }
  return rows;
}
/**
 * True when a team wait reports this task's finish instead of a separate supervision notice:
 * the wait is still open, or its wake notice already listed the task in this state.
 */
export function coveredByTeamWait(
  state: DomainState,
  destination: string,
  task: Record<string, unknown>,
) {
  if (!teamWaitDoneStates.includes(String(task.state))) return false;
  const wait = readTeamWait(state, destination);
  if (!wait?.taskIds.includes(String(task.id))) return false;
  if (wait.status === "waiting") return true;
  return wait.status === "woken" && String(task.updatedAt) <= wait.updatedAt;
}
/**
 * Wakes every team wait whose targets all finished or whose fallback passed. Each wake is one
 * command keyed by the wait's revision, so restarts and repeated ticks wake a chat once.
 */
export async function settleTeamWaits(
  context: RuntimeContext,
  at: string,
  onError?: (code: string) => void,
) {
  const state = context.store.snapshot(["settings", "task", "thread", "turn", "item"]);
  for (const wait of waits(state)) {
    if (wait.status !== "waiting") continue;
    const done = teamWaitTargets(state, wait).every((t) => t.done);
    const reason = done ? "finished" : wait.fallbackAt <= at ? "fallback" : undefined;
    if (!reason) continue;
    const commandId = `team-wait:wake:${wait.id}:${wait.revision}`;
    if (!context.store.receipt(commandId)) {
      const before = context.store.lastSeq();
      context.store.dispatch(commandId, (s) =>
        wakeTeamWait(s, wait.threadId, wait.id, reason, {
          commandId,
          at,
          actor: { kind: "system", id: "team-wait" },
        }),
      );
      context.publish(context.store.eventsSince(before));
    }
    try {
      await context.wake(wait.threadId);
    } catch {
      onError?.("team_wait_wake_failed");
    }
  }
}
