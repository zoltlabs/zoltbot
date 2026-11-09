import type { Routine, RoutineOccurrence } from "@zoltbot/protocol";
export const ROUTINE_FOLDER_WAIT_MS = 15 * 60_000;
export const ROUTINE_PERMISSION_TIMEOUT_MS = 30 * 60_000;

export function routineOutcome(text: string): "nothing" | "actionable" | "needs_you" {
  const marker = /\n?\[ZOLTBOT_OUTCOME:(nothing|actionable|needs_you)\]\s*$/.exec(text);
  // Multiple or malformed markers are never silently classified as nothing.
  return marker && text.split("[ZOLTBOT_OUTCOME:").length === 2
    ? (marker[1] as "nothing" | "actionable" | "needs_you")
    : "actionable";
}
export function routineShouldNotify(
  notify: Routine["notify"],
  outcome: RoutineOccurrence["outcome"],
) {
  return notify === "always" || outcome !== "nothing";
}
