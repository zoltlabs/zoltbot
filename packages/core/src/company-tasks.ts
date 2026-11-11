import { type CompanyPlan, type DomainEvent, parse, TaskSchema } from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { companyAccess } from "./company.js";
import { companyRecord } from "./company-changes.js";
import { applyEvents, type DomainState } from "./projectors.js";
import { taskReady } from "./task-graph.js";
import { scopeContains } from "./team.js";
import type { WorkspaceActor } from "./workspace-shape.js";

const levels = ["read_only", "workspace_write", "workspace_write_net", "full_access"];

export function activePlanCommitments(
  state: DomainState,
  planId: string | undefined,
  excludeTaskId?: string,
) {
  if (!planId) return [];
  return (state.task ?? []).filter(
    (r) =>
      r.authorityPlanId === planId &&
      r.state !== "cancelled" &&
      (!excludeTaskId || r.id !== excludeTaskId),
  );
}

export function resolveTaskAuthority(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  projectId: string,
  initiativeId: string | undefined,
  planId: string | undefined,
  options: {
    fallbackPlanId?: string | undefined;
    allowSingleActivePlan?: boolean | undefined;
    allowInactiveInitiative?: boolean | undefined;
    accountableThreadId?: string | undefined;
    parentId?: string | undefined;
    targetNode?: unknown;
  } = {},
) {
  if (!actor) throw Error("assignment_authority_required");
  const executingParent =
    options.parentId && options.targetNode
      ? state.task?.find(
          (r) =>
            r.id === options.parentId &&
            r.threadId === actor.threadId &&
            (!planId || r.authorityPlanId === planId) &&
            r.projectId === projectId &&
            r.state === "running" &&
            scopeContains(state, r.node, options.targetNode),
        )
      : undefined;
  if (!executingParent) companyAccess(state, actor, projectId);
  const explicitPlanId =
    planId ?? options.fallbackPlanId ?? (executingParent?.authorityPlanId as string | undefined);
  const matchingPlans = (state.companyPlan ?? []).filter(
    (r) =>
      r.state === "applied" &&
      r.projectId === projectId &&
      (explicitPlanId
        ? r.id === explicitPlanId
        : options.allowSingleActivePlan &&
          !!initiativeId &&
          (r.authority as CompanyPlan["authority"])?.initiativeId === initiativeId),
  );
  const plan = explicitPlanId
    ? matchingPlans[0]
    : matchingPlans.sort((a, b) =>
        String(b.approvedAt ?? b.createdAt).localeCompare(String(a.approvedAt ?? a.createdAt)),
      )[0];
  const authority = plan?.authority as CompanyPlan["authority"];
  if (!plan || !authority || !initiativeId || authority.initiativeId !== initiativeId)
    throw Error("approved_authority_required");
  const owner = state.initiativeRecord?.find((r) => r.id === authority.initiativeId);
  if (!owner) throw Error("approved_authority_required");
  if (!options.allowInactiveInitiative) {
    if (owner.state === "paused") throw Error("initiative_paused: initiative work is frozen");
    if (owner.state !== "active") throw Error("initiative_not_active");
  }
  const isChief = state.settings?.some(
    (r) => r.key === "chief.thread" && r.value === actor.threadId,
  );
  const proposingChief = plan.requestedBy === actor.threadId && isChief;
  const accountableMatch =
    !!options.accountableThreadId && options.accountableThreadId === actor.threadId;
  if (
    !executingParent &&
    owner.managerThreadId !== actor.threadId &&
    !accountableMatch &&
    !proposingChief
  )
    throw Error("initiative_owner_required");
  return { plan, authority, owner, executingParent };
}

export function checkProfileCeiling(
  state: DomainState,
  profileId: string,
  permissionCeiling: string,
) {
  const profile = state.agent?.find((r) => r.id === profileId && !r.archived);
  const level = levels.indexOf(String(profile?.permissionProfile));
  if (level < 0 || level > levels.indexOf(permissionCeiling))
    throw Error("assignment_permission_ceiling");
}

export function dispatchCompanyTask(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  input: {
    taskId: string;
    planId?: string;
    brief?: string;
    acceptance?: string;
    profileId?: string;
    accountableThreadId?: string;
    budgetUsd?: number;
  },
  context: CommandContext,
): Outcome {
  const row = state.task?.find((r) => r.id === input.taskId);
  if (!row) throw Error("task_unavailable");
  const task = parse(TaskSchema, row);
  const projectId = String(task.projectId ?? "");
  if (!projectId) throw Error("project_unavailable");
  if (task.state !== "queued")
    throw Error(`task_not_queued: task ${task.id} is already ${task.state}`);
  const profileId = input.profileId ?? String(task.ownerAgentId ?? "");
  let effectivePlanId = input.planId ?? task.authorityPlanId;
  const nextBudget = input.budgetUsd ?? task.budgetUsd;
  if (context.actor.kind !== "human") {
    const resolved = resolveTaskAuthority(
      state,
      actor,
      projectId,
      task.initiativeId,
      input.planId,
      {
        fallbackPlanId: task.authorityPlanId,
        allowSingleActivePlan: true,
        accountableThreadId: task.accountableThreadId,
      },
    );
    effectivePlanId = String(resolved.plan.id);
    checkProfileCeiling(state, profileId, resolved.authority.permissionCeiling);
    const committed = activePlanCommitments(state, effectivePlanId, task.id);
    if (committed.length >= resolved.authority.maxTasks) throw Error("assignment_task_limit");
    const spent = committed.reduce((sum, r) => sum + Number(r.budgetUsd ?? 0), 0);
    if (nextBudget === undefined && task.authorityPlanId !== effectivePlanId)
      throw Error("assignment_budget_limit");
    if (spent + Number(nextBudget ?? 0) > resolved.authority.budgetUsd + 1e-9)
      throw Error("assignment_budget_limit");
  } else if (task.initiativeId) {
    const initiative = state.initiativeRecord?.find((r) => r.id === task.initiativeId);
    if (initiative?.state === "paused") throw Error("initiative_paused: initiative work is frozen");
    if (initiative?.state === "cancelled") throw Error("initiative_not_active");
  }
  const brief = input.brief?.trim() ? input.brief.trim() : task.brief;
  const acceptance = input.acceptance?.trim() ? input.acceptance.trim() : task.acceptance;
  if (!brief || brief.length > (task.phaseExecution ? 16000 : 4000) || acceptance.length > 2000)
    throw Error("invalid_task");
  const accountableThreadId = input.accountableThreadId ?? task.accountableThreadId;
  if (
    accountableThreadId &&
    !state.thread?.some(
      (r) =>
        r.id === accountableThreadId &&
        (r.projectId === projectId ||
          state.settings?.some((s) => s.key === "chief.thread" && s.value === r.id)) &&
        !r.archived,
    )
  )
    throw Error("accountable_chat_unavailable");
  const historyChanged = accountableThreadId && accountableThreadId !== task.accountableThreadId;
  const { holdReason: _previous, ...rest } = task;
  const candidate: Record<string, unknown> = {
    ...rest,
    planned: false,
    brief,
    acceptance,
    ownerAgentId: profileId,
    ...(effectivePlanId ? { authorityPlanId: effectivePlanId } : {}),
    ...(nextBudget !== undefined ? { budgetUsd: nextBudget } : {}),
    ...(accountableThreadId ? { accountableThreadId } : {}),
    ...(historyChanged
      ? {
          assignmentHistory: [
            ...(task.assignmentHistory ?? []),
            { threadId: accountableThreadId, at: context.at },
          ],
        }
      : {}),
    updatedAt: context.at,
  };
  const holdReason = taskReady(state, candidate);
  if (holdReason) candidate.holdReason = holdReason;
  if (
    !task.planned &&
    task.brief === brief &&
    task.acceptance === acceptance &&
    task.ownerAgentId === profileId &&
    task.accountableThreadId === accountableThreadId &&
    task.budgetUsd === nextBudget &&
    task.authorityPlanId === effectivePlanId &&
    task.holdReason === holdReason
  )
    return { events: [], result: task };
  const events: DomainEvent[] = [...companyRecord("task", candidate, context).events];
  let nextState = applyEvents(state, events);
  if (task.threadId && profileId !== task.ownerAgentId) {
    const thread = nextState.thread?.find((r) => r.id === task.threadId && r.kind === "task");
    if (thread) {
      const updatedThread = companyRecord(
        "thread",
        { ...thread, agentId: profileId, lastActivityAt: context.at },
        { ...context, commandId: `${context.commandId}:thread` },
      );
      events.push(...updatedThread.events);
      nextState = applyEvents(nextState, updatedThread.events);
    }
  }
  return {
    events: events.map((e, i) => ({ ...e, eventId: `${context.commandId}:${i}` })),
    result: parse(TaskSchema, candidate),
  };
}

export function cancelCompanyTask(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  input: {
    taskId: string;
    reason?: string;
    planId?: string;
    replacementTaskId?: string;
  },
  context: CommandContext,
): Outcome {
  const row = state.task?.find((r) => r.id === input.taskId);
  if (!row) throw Error("task_unavailable");
  const task = parse(TaskSchema, row);
  if (task.state === "cancelled") return { events: [], result: task };
  if (["completed", "failed"].includes(task.state))
    throw Error(`task_not_cancellable: task ${task.id} is already ${task.state}`);
  const projectId = String(task.projectId ?? "");
  if (context.actor.kind !== "human") {
    if (!actor) throw Error("assignment_authority_required");
    companyAccess(state, actor, projectId);
    const isChief = state.settings?.some(
      (r) => r.key === "chief.thread" && r.value === actor.threadId,
    );
    const isAccountable = task.accountableThreadId === actor.threadId;
    if (!isChief && !isAccountable) {
      resolveTaskAuthority(state, actor, projectId, task.initiativeId, input.planId, {
        fallbackPlanId: task.authorityPlanId,
        allowSingleActivePlan: true,
        allowInactiveInitiative: true,
        accountableThreadId: task.accountableThreadId,
      });
    }
  }
  if (
    input.replacementTaskId &&
    (input.replacementTaskId === task.id ||
      !state.task?.some((r) => r.id === input.replacementTaskId && r.projectId === projectId))
  )
    throw Error("replacement_task_unavailable");
  const reason = (input.reason?.trim() || "Cancelled within approved authority").slice(0, 240);
  const cancelled: Record<string, unknown> = {
    ...task,
    state: "cancelled",
    planned: false,
    holdReason: reason,
    ...(input.replacementTaskId ? { replacedByTaskId: input.replacementTaskId } : {}),
    updatedAt: context.at,
  };
  return companyRecord("task", cancelled, context);
}

export function submitCompanyTask(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  input: {
    taskId: string;
    status: "done" | "partial" | "blocked" | "failed";
    summary: string;
    files?: string[];
    planId?: string;
  },
  context: CommandContext,
): Outcome {
  const row = state.task?.find((r) => r.id === input.taskId);
  if (!row) throw Error("task_unavailable");
  const task = parse(TaskSchema, row);
  const projectId = String(task.projectId ?? "");
  const summary = input.summary.trim();
  if (!summary || summary.length > 2000) throw Error("invalid_task_summary");
  const files = (input.files ?? []).map((f) => f.trim()).filter(Boolean);
  if (files.length > 200) throw Error("result_too_large");
  const existingResult = state.taskResult?.find(
    (r) => r.taskId === task.id && r.revision === task.revision,
  );
  if (task.state === "review" && existingResult && existingResult.summary === summary)
    return { events: [], result: { task, taskResult: existingResult } };
  if (!["queued", "running"].includes(task.state))
    throw Error(`task_already_${task.state}: task ${task.id} cannot accept a new submission`);
  let effectivePlanId = input.planId ?? task.authorityPlanId;
  if (context.actor.kind !== "human") {
    if (!actor) throw Error("assignment_authority_required");
    const isTaskOwnerThread = task.threadId === actor.threadId;
    if (!isTaskOwnerThread) {
      if (task.initiativeId) {
        const resolved = resolveTaskAuthority(
          state,
          actor,
          projectId,
          task.initiativeId,
          input.planId,
          {
            fallbackPlanId: task.authorityPlanId,
            allowSingleActivePlan: true,
            accountableThreadId: task.accountableThreadId,
          },
        );
        effectivePlanId = String(resolved.plan.id);
      } else {
        companyAccess(state, actor, projectId);
        const isChief = state.settings?.some(
          (r) => r.key === "chief.thread" && r.value === actor.threadId,
        );
        if (task.accountableThreadId !== actor.threadId && !isChief)
          throw Error("initiative_owner_required");
      }
    }
  }
  const depsHold = (task.dependencies ?? []).some(
    (id) => state.task?.find((r) => r.id === id)?.state !== "completed",
  );
  if (depsHold && input.status !== "blocked" && input.status !== "failed")
    throw Error("incomplete_dependencies: dependencies must be accepted before completing task");
  const executorThreadId = actor?.threadId ?? task.executorThreadId ?? task.threadId;
  const events: DomainEvent[] = [];
  let working = state;
  if (task.state === "queued") {
    const { holdReason: _previous, ...rest } = task;
    const claimed = companyRecord(
      "task",
      {
        ...rest,
        state: "running",
        planned: false,
        ...(effectivePlanId ? { authorityPlanId: effectivePlanId } : {}),
        ...(executorThreadId ? { executorThreadId } : {}),
        updatedAt: context.at,
      },
      { ...context, commandId: `${context.commandId}:claim` },
    );
    events.push(...claimed.events);
    working = applyEvents(working, claimed.events);
  }
  const submitted = handle(
    working,
    {
      type: "submitResult",
      id: task.id,
      revision: task.revision,
      status: input.status,
      summary,
      files,
    },
    { ...context, commandId: `${context.commandId}:submit` },
  );
  const patchedEvents = submitted.events.map((event) =>
    event.aggregateType === "task" && executorThreadId
      ? {
          ...event,
          payload: parse(TaskSchema, {
            ...(event.payload as Record<string, unknown>),
            planned: false,
            ...(effectivePlanId ? { authorityPlanId: effectivePlanId } : {}),
            executorThreadId,
          }),
        }
      : event,
  );
  events.push(...patchedEvents);
  const finalState = applyEvents(state, events);
  const finalTask = finalState.task?.find((r) => r.id === task.id);
  return {
    events: events.map((e, i) => ({ ...e, eventId: `${context.commandId}:${i}` })),
    result: {
      task: finalTask,
      taskResult: submitted.result,
    },
  };
}

export function recoverCompanyTask(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  input: {
    taskId: string;
    planId?: string;
    excludeOptionalKnowledgeIds?: string[];
    brief?: string;
  },
  context: CommandContext,
): Outcome {
  const row = state.task?.find((r) => r.id === input.taskId);
  if (!row) throw Error("task_unavailable");
  const task = parse(TaskSchema, row);
  const projectId = String(task.projectId ?? "");
  if (!["queued", "blocked", "failed"].includes(task.state))
    throw Error(`task_not_recoverable: task ${task.id} is already ${task.state}`);
  if (
    task.state === "blocked" &&
    context.actor.kind !== "human" &&
    (state.interaction ?? []).some((i) => i.threadId === task.threadId && i.state === "pending")
  )
    throw Error("pending_human_interaction: wait for pending human approval before recovering");
  if (context.actor.kind !== "human") {
    if (!actor) throw Error("assignment_authority_required");
    if (task.initiativeId) {
      resolveTaskAuthority(state, actor, projectId, task.initiativeId, input.planId, {
        fallbackPlanId: task.authorityPlanId,
        allowSingleActivePlan: true,
        accountableThreadId: task.accountableThreadId,
      });
    } else {
      companyAccess(state, actor, projectId);
    }
  }
  const initiative = task.initiativeId
    ? state.initiativeRecord?.find((r) => r.id === task.initiativeId)
    : undefined;
  const project = state.project?.find((r) => r.id === projectId);
  const initiativeRequired = new Set((initiative?.knowledgeIds as string[] | undefined) ?? []);
  const designRequired =
    ["page", "design"].includes(String(task.outputMode)) && project?.artifactDesignContextId
      ? String(project.artifactDesignContextId)
      : undefined;
  const requestedIds = [...new Set((input.excludeOptionalKnowledgeIds ?? []).filter(Boolean))];
  for (const id of requestedIds) {
    const item = state.knowledge?.find((k) => k.id === id && k.status === "active");
    if (!item) throw Error(`knowledge_unavailable: ${id}`);
    if (context.actor.kind !== "human") {
      if (
        item.pinned === true ||
        item.kind === "constraint" ||
        initiativeRequired.has(id) ||
        id === designRequired
      )
        throw Error(
          `required_context_cannot_be_excluded: ${id} is required (${item.kind === "constraint" ? "constraint" : "pinned/required"}); ask the human before removing required knowledge`,
        );
    }
  }
  const brief = input.brief?.trim() ? input.brief.trim() : task.brief;
  if (!brief || brief.length > (task.phaseExecution ? 16000 : 4000)) throw Error("invalid_task");
  const mergedExclusions = [...new Set([...(task.excludedKnowledgeIds ?? []), ...requestedIds])];
  const { holdReason: _previous, ...rest } = task;
  const nextRevision = task.state === "queued" ? task.revision : task.revision + 1;
  const candidate: Record<string, unknown> = {
    ...rest,
    state: "queued",
    revision: nextRevision,
    planned: false,
    brief,
    ...(mergedExclusions.length ? { excludedKnowledgeIds: mergedExclusions } : {}),
    updatedAt: context.at,
  };
  const graphHold = taskReady(state, candidate);
  if (graphHold) candidate.holdReason = graphHold;
  const events: DomainEvent[] = [...companyRecord("task", candidate, context).events];
  if (mergedExclusions.length) {
    const key = `knowledge.exclusions.${task.id}`;
    const existingSetting = state.settings?.some((r) => r.key === key);
    const settingOut = handle(
      applyEvents(state, events),
      existingSetting
        ? {
            type: "update",
            kind: "settings",
            id: key,
            changes: { value: { ids: mergedExclusions } },
          }
        : { type: "create", kind: "settings", value: { key, value: { ids: mergedExclusions } } },
      { ...context, commandId: `${context.commandId}:exclusions` },
    );
    events.push(...settingOut.events);
  }
  return {
    events: events.map((e, i) => ({ ...e, eventId: `${context.commandId}:${i}` })),
    result: parse(TaskSchema, candidate),
  };
}
