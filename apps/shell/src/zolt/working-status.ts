// C9: the line under a chat while its agent works: the agent's own words, else a line from the
// tool it is running.
import { chatStatusKey, statusLine } from "@zoltbot/protocol";
import type { Snapshot } from "./daemon-client";
import { runningTurn, text } from "./mapping";

type Row = Record<string, unknown>;

/** The working line for the chat's running turn, or null when no turn runs. */
export function workingStatus(snapshot: Snapshot, threadId: string, items: readonly Row[]) {
  const turnId = text(runningTurn(snapshot, threadId)?.id);
  if (!turnId) return null;
  const stored = (snapshot.entities.settings ?? []).find(
    (setting) => setting.key === chatStatusKey(threadId),
  )?.value;
  return statusLine({ stored, turnId, tools: items });
}
