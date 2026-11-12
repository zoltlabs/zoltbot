import { compareSessions } from "@zoltbot/protocol";
import { backgroundTasks } from "./parity-data.js";
import { delegatedActive, delegatedWork } from "./results-data.js";
import { body, type Row, text } from "./types.js";

type Entities = Record<string, Row[] | undefined>;
export type WaitingState = {
  label: string;
  description: string;
  kind: "connection" | "provider" | "request" | "work";
};
/** State reflects recorded execution, never guesses from an agent's prose. */
export function waitingState(
  entities: Entities,
  threadId: string,
  connection: string,
): WaitingState | undefined {
  if (connection !== "online")
    return {
      label: "Waiting for connection",
      description: "Reconnecting to Zoltbot. Agent status will update when connected.",
      kind: "connection",
    };
  const sessions = (entities.session ?? [])
    .filter((row) => row.threadId === threadId)
    .sort(compareSessions);
  const session = sessions[0];
  // An uncertain delivery is handled by SessionBanner; never suggest a resend here.
  if (
    (entities.item ?? []).some(
      (row) =>
        row.threadId === threadId && row.kind === "user" && body(row).queueState === "uncertain",
    )
  )
    return undefined;
  const request = entities.interaction?.find(
    (row) => row.threadId === threadId && row.state === "pending",
  );
  if (request) {
    const labels: Record<string, string> = {
      approval: "Approval needed",
      question: "Answer needed",
      plan: "Plan review needed",
      form: "Details needed",
      gate: "Sign-off needed",
    };
    return {
      label: labels[text(request.type)] ?? "Needs you",
      description: "Review the pending request to continue.",
      kind: "request",
    };
  }
  const status = session?.runtimeStatus as Row | undefined;
  if (status?.state === "rate_limited") {
    const date = new Date(text(status.resetsAt));
    const reset = Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
    return {
      label: "Usage limit reached",
      description: reset
        ? `Try again after ${reset}.`
        : "Try again when your coding tool’s usage limit resets.",
      kind: "provider",
    };
  }
  if (status?.state === "reconnecting" && !["closed", "failed"].includes(text(session?.state)))
    return {
      label: "Coding tool reconnecting",
      description: "Waiting for the coding tool to restore its connection.",
      kind: "provider",
    };
  if (status?.state === "auth_required" || session?.endReason === "auth_required")
    return {
      label: "Sign-in required",
      description: "Sign in to your coding tool, then reconnect.",
      kind: "provider",
    };
  if (status?.state === "error")
    return {
      label: "Coding tool needs attention",
      description: "Check the latest error in the conversation before trying again.",
      kind: "provider",
    };
  if (session?.state === "starting")
    return {
      label: "Connecting to coding tool",
      description: "Waiting for the native session to become ready.",
      kind: "provider",
    };
  if (entities.turn?.some((row) => row.threadId === threadId && row.status === "running"))
    return undefined;
  const task = entities.task?.find((row) => row.threadId === threadId);
  if (delegatedWork(entities, threadId).some(delegatedActive))
    return {
      label: "Delegated work in progress",
      description: "Open Results to check the delegated tasks.",
      kind: "work",
    };
  if (backgroundTasks(session).some((task) => task.state === "running"))
    return {
      label: "Background work in progress",
      description: "The agent has a job running in the background.",
      kind: "work",
    };
  if (task?.state === "blocked")
    return {
      label: "Waiting to resume",
      description: text(task.holdReason) || "Review the task to see what is blocking it.",
      kind: "work",
    };
  return undefined;
}
