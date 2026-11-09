import {
  parse,
  type Wake,
  type WakeCondition,
  type WakeInput,
  WakeInputSchema,
} from "@zoltbot/protocol";
import type { Row, Snapshot } from "./transport";
import { text } from "./view";

export const wakeKinds: { value: WakeCondition["kind"]; label: string }[] = [
  { value: "job", label: "Background job finishes" },
  { value: "task", label: "Task finishes" },
  { value: "turn", label: "Another chat turn finishes" },
  { value: "pr", label: "Pull request merges" },
  { value: "ci", label: "CI run finishes" },
  { value: "topic", label: "A topic resurfaces" },
];
export function wakeSources(snapshot: Snapshot, threadId: string, kind: string) {
  const e = snapshot.entities;
  const projectId = text(e.thread?.find((t) => t.id === threadId)?.projectId);
  const threads = (e.thread ?? []).filter((t) => !t.archived && text(t.projectId) === projectId);
  const ids = new Set(threads.map((t) => t.id));
  if (kind === "job")
    return (e.session ?? [])
      .filter((s) => ids.has(s.threadId))
      .flatMap((s) =>
        (Array.isArray(s.background) ? (s.background as Row[]) : []).map((j) => ({
          value: `${encodeURIComponent(text(s.id))}|${encodeURIComponent(text(j.id))}`,
          label: `${text(j.description) || text(j.id)} · ${text(j.state)} · ${text(s.id)}`,
        })),
      );
  if (kind === "task")
    return (e.task ?? [])
      .filter((t) => t.threadId !== threadId && ids.has(t.threadId))
      .map((t) => ({
        value: text(t.id),
        label: `${text(t.title)} · ${text(t.state)} · ${text(t.id)}`,
      }));
  return (e.turn ?? [])
    .filter((t) => t.threadId !== threadId && ids.has(t.threadId))
    .map((t) => ({
      value: text(t.id),
      label: `${text(threads.find((th) => th.id === t.threadId)?.title)} · ${new Date(text(t.startedAt)).toLocaleString()} · ${text(t.status)} · ${text(t.id)}`,
    }));
}
export const localWakeTime = (at: string) => {
  const date = new Date(at);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
export const wakeSelection = (wake?: Wake) => {
  const c = wake?.condition;
  return c?.kind === "job"
    ? `${encodeURIComponent(c.sessionId)}|${encodeURIComponent(c.jobId)}`
    : c?.kind === "task"
      ? c.taskId
      : c?.kind === "turn"
        ? c.turnId
        : "";
};
export type WakeForm = {
  kind: WakeCondition["kind"];
  selected: string;
  repository: string;
  number: string;
  attempt: string;
  phrase: string;
  outcome: "finished" | "passed";
  behavior: "inbox" | "resume";
  continuation: string;
  fallback: string;
};
export function wakeInput(
  threadId: string,
  projectId: string,
  form: WakeForm,
  now = Date.now(),
): WakeInput {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(form.fallback))
    throw Error("Use YYYY-MM-DDTHH:mm for the fallback time.");
  const date = new Date(form.fallback);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now)
    throw Error("Choose a fallback time in the future.");
  if (localWakeTime(date.toISOString()) !== form.fallback)
    throw Error("That local time does not exist. Choose another fallback time.");
  if (form.kind === "topic" && !projectId) throw Error("Topic waits need a workspace.");
  if (form.behavior === "resume" && form.kind !== "topic" && !form.continuation.trim())
    throw Error("Enter the next step to resume automatically.");
  if ((form.kind === "pr" || form.kind === "ci") && !/^[0-9]+$/.test(form.number.trim()))
    throw Error("Enter a numeric pull request number or workflow run ID.");
  if (form.kind === "ci" && !/^[0-9]+$/.test(form.attempt.trim()))
    throw Error("Enter a positive run attempt number.");
  const { kind, outcome } = form;
  let condition: WakeCondition;
  if (kind === "pr")
    condition = { kind, repository: form.repository.trim(), number: Number(form.number) };
  else if (kind === "ci")
    condition = {
      kind,
      repository: form.repository.trim(),
      runId: form.number.trim(),
      attempt: Number(form.attempt),
      outcome,
    };
  else if (kind === "topic") condition = { kind, projectId, phrase: form.phrase.trim() };
  else if (kind === "job") {
    const [sessionId, jobId] = form.selected.split("|");
    condition = {
      kind,
      sessionId: decodeURIComponent(sessionId ?? ""),
      jobId: decodeURIComponent(jobId ?? ""),
      outcome,
    };
  } else if (kind === "task") condition = { kind, taskId: form.selected, outcome };
  else condition = { kind, turnId: form.selected, outcome };
  try {
    return parse(WakeInputSchema, {
      threadId,
      condition,
      fallbackAt: date.toISOString(),
      behavior: kind === "topic" ? "inbox" : form.behavior,
      continuation: form.continuation.trim(),
    });
  } catch {
    throw Error("Check the selected source and required fields, then save again.");
  }
}
