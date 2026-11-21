// R7: the words the Workflows view shows for steps, runs and their states.
import type {
  WorkflowItem,
  WorkflowRunItem,
  WorkflowStep,
  WorkflowStepState,
} from "../../../../shared/workflows";
import { type MessageKey, t } from "../../i18n";
import { dateTimeText, scheduleText } from "./routine-format";

const KIND: Record<WorkflowStep["kind"], MessageKey> = {
  trigger: "workflows.kind.trigger",
  agent: "workflows.kind.agent",
  condition: "workflows.kind.condition",
  wait: "workflows.kind.wait",
  connection: "workflows.kind.connection",
  media: "workflows.kind.media",
};
const STEP: Record<WorkflowStepState, MessageKey> = {
  waiting: "workflows.step.waiting",
  running: "workflows.step.running",
  needs_you: "workflows.step.needsYou",
  done: "workflows.step.done",
  skipped: "workflows.step.skipped",
  failed: "workflows.step.failed",
};
const RUN: Record<WorkflowRunItem["state"], MessageKey> = {
  scheduled: "workflows.run.running",
  running: "workflows.run.running",
  looping: "workflows.run.running",
  at_gate: "workflows.run.needsYou",
  completed: "workflows.run.done",
  failed: "workflows.run.failed",
  cancelled: "workflows.run.stopped",
};
const REASON: Record<string, MessageKey> = {
  workflow_budget_reached: "workflows.reason.budget",
  workflow_time_limit: "workflows.reason.time",
  workflow_stopped: "workflows.reason.stopped",
  workflow_step_failed: "workflows.reason.step",
};
const TEST: Record<NonNullable<WorkflowStep["test"]>["kind"], MessageKey> = {
  contains: "workflows.detail.contains",
  equals: "workflows.detail.equals",
  outcome: "workflows.detail.outcome",
};

export const kindText = (step: WorkflowStep) => t(KIND[step.kind]);
export const stepStateText = (state: WorkflowStepState) => t(STEP[state]);
export const runStateText = (run: WorkflowRunItem) => t(RUN[run.state]);
export const reasonText = (reason: string | undefined) =>
  reason && REASON[reason] ? t(REASON[reason]) : "";

export function triggerText(item: WorkflowItem): string {
  return item.trigger.type === "schedule"
    ? item.trigger.cron === "@once"
      ? t("routines.when.once")
      : scheduleText(item.trigger)
    : t("workflows.trigger.manual");
}

/** One line for the list: when it runs and how many steps it has. */
export function workflowMeta(item: WorkflowItem): string {
  return t("workflows.meta", {
    when: triggerText(item),
    count: item.steps.filter((step) => step.kind !== "trigger").length,
  });
}

/** The newest run's state, or "Paused". */
export function workflowStatus(item: WorkflowItem): string {
  if (item.paused) return t("routines.status.paused");
  const latest = item.runs[0];
  return latest ? runStateText(latest) : t("workflows.run.none");
}

export function runLabel(run: WorkflowRunItem, timezone: string): string {
  return t("workflows.run.option", {
    when: run.startedAt ? dateTimeText(run.startedAt, timezone) : "",
    state: runStateText(run),
  });
}

/** What the step does, in a sentence, for the side panel. */
export function stepDetail(step: WorkflowStep, names: Map<string, string>): string {
  if (step.kind === "trigger") return "";
  if (step.test)
    return t(TEST[step.test.kind], {
      step: names.get(step.test.from) ?? step.test.from,
      value: step.test.value,
    });
  if (step.wait)
    return "approval" in step.wait
      ? t("workflows.detail.approval")
      : t("workflows.detail.minutes", { count: step.wait.minutes });
  if (step.action)
    return t("workflows.detail.connection", {
      connection: step.action.connection,
      action: step.action.action,
    });
  if (step.output)
    return t(step.output === "video" ? "workflows.detail.video" : "workflows.detail.image");
  return "";
}
