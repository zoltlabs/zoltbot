import {
  type DomainEvent,
  type OutputMode,
  type PermissionProfile,
  parse,
  parseEvent,
  type Routine,
  type RoutineOccurrence,
  type Task,
  TaskSchema,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { createScopedChat, scopeLineage } from "./hierarchy.js";
import { queueTaskInput } from "./input-queue.js";
import { applyEvents, type DomainState } from "./projectors.js";
import { routineOutcome } from "./routine-policy.js";
import { taskReady, validateTaskGraph } from "./task-graph.js";
import { scopeContains } from "./team.js";
import { transition } from "./transitions.js";

// D122: a task run is a task thread started from a bounded brief, one revision at a time.
const FEEDBACK = "\n\nReview feedback:\n";
const SUMMARY =
  "When you finish, end with a short summary of what you did, what changed and anything left open. Zoltbot shows that last message to the human for review.";
export interface TaskInput {
  sourceMessageId?: string;
  executionThreadId?: string;
  existingThreadId?: string;
  initiativeId?: string;
  accountableThreadId?: string;
  parentId?: string;
  dependencies?: string[];
  planned?: boolean;
  budgetUsd?: number;
  authorityPlanId?: string;
  outputMode?: OutputMode;
  id: string;
  title: string;
  brief: string;
  acceptance?: string;
  profileId: string;
  node: { type: string; id: string };
  workspaceMode?: "shared" | "worktree";
  baseRef?: string;
  browser?: { mode: "visible" | "background"; url?: string };
  routineOccurrenceId?: string;
  permissionCeiling?: PermissionProfile;
  phaseExecution?: Task["phaseExecution"];
  workflowRunId?: string;
  stageId?: string;
  workspaceId?: string;
  routineInputs?: Routine["template"]["inputs"];
  workspace?: { id: string; path: string; repoRoot: string; baseRef: string };
}
function numbered(events: DomainEvent[], context: CommandContext): DomainEvent[] {
  return events.map((event, index) => ({ ...event, eventId: `${context.commandId}:${index}` }));
}
function taskEvent(task: Record<string, unknown>, context: CommandContext, verb = "updated") {
  const value = parse(TaskSchema, task);
  return parseEvent({
    eventId: `${context.commandId}:0`,
    commandId: context.commandId,
    aggregateType: "task",
    aggregateId: value.id,
    type: `task.${verb}`,
    occurredAt: context.at,
    payload: value,
  });
}
function current(state: DomainState, taskId: string, revision?: number): Task {
  const row = state.task?.find((entry) => entry.id === taskId);
  if (!row) throw new Error(`not_found: task ${taskId}`);
  const task = parse(TaskSchema, row);
  if (revision !== undefined && task.revision !== revision)
    throw new Error("stale_revision: task revision changed");
  return task;
}
function moved(task: Task, to: Task["state"], context: CommandContext, holdReason?: string) {
  transition("task", task.state, to);
  const { holdReason: _previous, ...rest } = task;
  return {
    ...rest,
    state: to,
    ...(holdReason ? { holdReason } : {}),
    updatedAt: context.at,
  };
}

export function createTask(state: DomainState, input: TaskInput, context: CommandContext): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_task_required");
  return buildTask(state, input, context);
}
/** Called by bounded company authority or an existing manager's delegation. */
export function createAssignedTask(
  state: DomainState,
  input: TaskInput,
  context: CommandContext,
): Outcome {
  const source = state.thread?.find(
    (r) => r.agentId === context.actor.id && r.id === input.accountableThreadId && !r.archived,
  );
  const plan = state.companyPlan?.find(
    (r) => r.id === input.authorityPlanId && r.state === "applied",
  );
  if (
    context.actor.kind !== "human" &&
    !plan &&
    !(source?.node && scopeContains(state, source.node, input.node))
  )
    throw Error("assignment_authority_required");
  return buildTask(state, input, context);
}
/** Narrow delegation: provider events are provenance, never human principals. */
export function createDelegatedRoutineTask(
  state: DomainState,
  routine: Routine,
  occurrence: RoutineOccurrence,
  context: CommandContext,
): Outcome {
  const saved = state.routine?.find((row) => row.id === routine.id);
  if (
    context.actor.kind !== "system" ||
    (saved !== routine && JSON.stringify(saved) !== JSON.stringify(routine)) ||
    !routine.event?.authorizedBy ||
    (routine.paused && !occurrence.manual) ||
    routine.permissionCeiling !== "read_only" ||
    !occurrence.taskId ||
    !occurrence.sourceEvent ||
    !occurrence.frozenBrief
  )
    throw new Error("routine_grant_required");
  return buildTask(
    state,
    {
      id: occurrence.taskId,
      title: routine.template.title,
      brief: occurrence.frozenBrief,
      acceptance: routine.template.acceptance,
      profileId: routine.template.profileId,
      node: routine.template.node,
      routineOccurrenceId: occurrence.id,
      permissionCeiling: "read_only",
      routineInputs: routine.template.inputs,
    },
    context,
  );
}
function buildTask(state: DomainState, input: TaskInput, context: CommandContext): Outcome {
  const title = input.title.trim(),
    brief = input.brief.trim(),
    acceptance = input.acceptance?.trim() ?? "";
  if (
    !title ||
    title.length > 150 ||
    !brief ||
    brief.length > (input.phaseExecution ? 16000 : 4000) ||
    acceptance.length > 2000
  )
    throw new Error("invalid_task");
  if (state.task?.some((row) => row.id === input.id)) throw new Error("already_exists: task");
  const browser = input.browser ?? input.routineInputs?.browser;
  if (browser) {
    if (state.agent?.find((row) => row.id === input.profileId)?.permissionProfile === "read_only")
      throw new Error("browser_requires_shell_workspace_write_profile");
    if (browser.url) {
      const url = new URL(browser.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("browser_url_requires_plain_http_origin_or_path");
    }
  }
  const lineage = scopeLineage(state, input.node);
  const threadId = input.existingThreadId ?? input.executionThreadId ?? `${input.id}:thread`;
  const existing = input.existingThreadId
    ? state.thread?.find(
        (r) => r.id === input.existingThreadId && !r.archived && r.projectId === lineage.project.id,
      )
    : undefined;
  if (
    input.existingThreadId &&
    (!existing ||
      state.task?.some(
        (r) =>
          r.threadId === threadId &&
          !["completed", "failed", "cancelled"].includes(String(r.state)),
      ))
  )
    throw Error("chat_has_active_assignment");
  const task = {
    id: input.id,
    ...(input.phaseExecution ? { phaseExecution: input.phaseExecution } : {}),
    ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    ...(input.stageId ? { stageId: input.stageId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.routineOccurrenceId
      ? {
          routineOccurrenceId: input.routineOccurrenceId,
          permissionCeiling: input.permissionCeiling,
        }
      : {}),
    ...(input.routineInputs ? { routineInputs: input.routineInputs } : {}),
    projectId: lineage.project.id,
    node: input.node,
    rootId: input.parentId
      ? String(state.task?.find((r) => r.id === input.parentId)?.rootId ?? input.parentId)
      : input.id,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.initiativeId ? { initiativeId: input.initiativeId } : {}),
    ...(input.accountableThreadId
      ? {
          accountableThreadId: input.accountableThreadId,
          assignmentHistory: [{ threadId: input.accountableThreadId, at: context.at }],
        }
      : {}),
    ...(input.authorityPlanId ? { authorityPlanId: input.authorityPlanId } : {}),
    ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    dependencies: input.dependencies ?? [],
    planned: input.planned ?? false,
    ...((input.browser ?? input.routineInputs?.browser)
      ? { browser: input.browser ?? input.routineInputs?.browser }
      : {}),
    title,
    brief,
    acceptance,
    expectedDeliverable:
      input.outputMode && input.outputMode !== "auto" ? input.outputMode.replaceAll("_", " ") : "",
    ...(input.outputMode ? { outputMode: input.outputMode } : {}),
    ownerAgentId: input.profileId,
    threadId,
    workspaceMode: input.workspace ? "worktree" : (input.workspaceMode ?? "shared"),
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    ...(input.workspace
      ? { workspaceId: input.workspace.id, baseRef: input.workspace.baseRef }
      : {}),
    state: "queued",
    revision: 1,
    attempt: 1,
    maxAttempts: 1,
    reviewRequired: true,
    executionLocation: "local_host",
    createdBy: context.actor,
    createdAt: context.at,
    updatedAt: context.at,
  };
  if (
    input.initiativeId &&
    !state.initiativeRecord?.some(
      (r) =>
        r.id === input.initiativeId &&
        r.projectId === lineage.project.id &&
        !["completed", "cancelled"].includes(String(r.state)),
    )
  )
    throw Error("initiative_unavailable");
  if (
    input.accountableThreadId &&
    !state.thread?.some(
      (r) =>
        r.id === input.accountableThreadId &&
        (r.projectId === lineage.project.id ||
          state.settings?.some(
            (setting) => setting.key === "chief.thread" && setting.value === r.id,
          )) &&
        !r.archived,
    )
  )
    throw Error("accountable_chat_unavailable");
  validateTaskGraph(state, task);
  const workspace = input.workspace
    ? handle(
        state,
        {
          type: "create",
          kind: "workspace",
          value: {
            ...input.workspace,
            projectId: lineage.project.id,
            kind: "worktree",
            state: "active",
            createdAt: context.at,
          },
        },
        context,
      ).events
    : [];
  const created = [...workspace, taskEvent(task, context, "created")];
  const chat = existing
    ? handle(
        applyEvents(state, created),
        { type: "update", kind: "thread", id: threadId, changes: { taskId: input.id } },
        context,
      )
    : createScopedChat(
        applyEvents(state, created),
        {
          id: threadId,
          agentId: input.profileId,
          projectId: lineage.project.id,
          node: input.node,
          taskId: input.id,
          kind: "task",
          title,
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: context.at,
          lastActivityAt: context.at,
        },
        context,
      );
  return { events: numbered([...created, ...chat.events], context), result: task };
}

/** The first message of each revision: the brief, the review feedback or a retry note. */
export function taskPrompt(task: Task): string {
  if (task.revision === 1)
    return [
      `[Zoltbot task: ${task.title}]`,
      task.brief,
      task.acceptance ? `Acceptance criteria:\n${task.acceptance}` : "",
      SUMMARY,
      task.routineOccurrenceId
        ? "Report a structured outcome on the final line, exactly [ZOLTBOT_OUTCOME:nothing], [ZOLTBOT_OUTCOME:actionable], or [ZOLTBOT_OUTCOME:needs_you]. Use nothing only when no human action or attention is needed."
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  if (task.reviewState === "changes" && task.brief.includes(FEEDBACK))
    return [
      `[Zoltbot task: ${task.title}, revision ${task.revision}]`,
      `The human reviewed your result and asked for changes:\n${task.brief.slice(task.brief.lastIndexOf(FEEDBACK) + FEEDBACK.length)}`,
      SUMMARY,
    ].join("\n\n");
  return [
    `[Zoltbot task: ${task.title}, revision ${task.revision}]`,
    "The last attempt did not finish. Try again from where you stopped.",
    SUMMARY,
  ].join("\n\n");
}

export function startTask(
  state: DomainState,
  taskId: string,
  revision: number,
  context: CommandContext,
): Outcome {
  const task = current(state, taskId, revision);
  const hold = taskReady(state, task);
  if (hold) throw Error(hold);
  const next = moved(task, "running", context);
  const started = [taskEvent(next, context)];
  const queued = queueTaskInput(
    applyEvents(state, started),
    taskId,
    taskPrompt(task),
    `${taskId}:r${revision}:input`,
    context,
  );
  return { events: numbered([...started, ...queued.events], context), result: next };
}

export function holdTask(
  state: DomainState,
  taskId: string,
  reason: string | undefined,
  context: CommandContext,
): Outcome {
  const task = current(state, taskId);
  if (task.state !== "queued" || task.holdReason === reason) return { events: [], result: task };
  const { holdReason: _previous, ...rest } = task;
  const next = { ...rest, ...(reason ? { holdReason: reason } : {}), updatedAt: context.at };
  return { events: [taskEvent(next, context)], result: next };
}

/** Turn the end of a task turn into a bounded result for review, or a failed attempt. */
export function finishTaskTurn(
  state: DomainState,
  taskId: string,
  revision: number,
  outcome: { status: "completed" | "failed" | "interrupted"; text: string; reason?: string },
  context: CommandContext,
): Outcome {
  const task = current(state, taskId, revision);
  if (task.state !== "running") return { events: [], result: task };
  if (outcome.status !== "completed") {
    const reason =
      outcome.status === "interrupted"
        ? "Stopped before it finished"
        : `The agent turn failed${outcome.reason ? ` (${outcome.reason})` : ""}`;
    const next = moved(task, "failed", context, reason);
    return { events: [taskEvent(next, context)], result: next };
  }
  const visible = task.routineOccurrenceId
    ? outcome.text.replace(/\n?\[ZOLTBOT_OUTCOME:(nothing|actionable|needs_you)\]\s*$/, "")
    : outcome.text;
  const summary = visible.trim().slice(-2000) || "The agent finished without a summary.";
  const submitted = handle(
    state,
    { type: "submitResult", id: taskId, revision, status: "done", summary, files: [] },
    context,
  );
  return {
    events: submitted.events.map((event) =>
      event.aggregateType === "taskResult"
        ? {
            ...event,
            payload: {
              ...(event.payload as object),
              auto: true,
              ...(task.routineOccurrenceId ? { outcome: routineOutcome(outcome.text) } : {}),
            },
          }
        : event,
    ),
    result: {
      ...submitted.result,
      auto: true,
      ...(task.routineOccurrenceId ? { outcome: routineOutcome(outcome.text) } : {}),
    },
  };
}

export function retryTask(
  state: DomainState,
  taskId: string,
  revision: number,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw new Error("human_task_required");
  const task = current(state, taskId, revision);
  const next = {
    ...moved(task, "queued", context),
    revision: task.revision + 1,
    reviewState: "retry",
  };
  return { events: [taskEvent(next, context)], result: next };
}

export function cancelTask(
  state: DomainState,
  taskId: string,
  confirmed: boolean,
  context: CommandContext,
): Outcome {
  if (!confirmed || context.actor.kind !== "human")
    throw new Error("confirmation_required: explicit human confirmation needed");
  const task = current(state, taskId);
  const next = moved(task, "cancelled", context, "Stopped by you");
  return { events: [taskEvent(next, context)], result: next };
}

/** After a daemon restart, continue a task that recovery parked, in its existing native conversation. */
export function resumeTask(
  state: DomainState,
  taskId: string,
  bootId: string,
  context: CommandContext,
): Outcome {
  const task = current(state, taskId);
  if (task.state !== "blocked" || task.holdReason !== "daemon_restarted")
    return { events: [], result: task };
  const next = moved(task, "running", context);
  const resumed = [taskEvent(next, context)];
  const queued = queueTaskInput(
    applyEvents(state, resumed),
    taskId,
    // A provider may not have saved the interrupted turn, so the note repeats this revision's brief.
    `[Zoltbot] Zoltbot restarted while you were working on this task. If your earlier progress is still in this conversation, continue from where you stopped. Otherwise start again from this brief:\n\n${taskPrompt(task)}`,
    `${taskId}:r${task.revision}:resume:${bootId}`,
    context,
  );
  return { events: numbered([...resumed, ...queued.events], context), result: next };
}
