import {
  type CompanyPlan,
  CompanyPlanSchema,
  type InitiativeRecord,
  InitiativeRecordSchema,
  type ManagerRemit,
  ManagerRemitSchema,
  type ProjectBrief,
  parse,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { applyCompanyChanges, companyBaseline, companyRecord } from "./company-changes.js";
import { scopeLineage } from "./hierarchy.js";
import { queueSystemNotice } from "./input-queue.js";
import type { DomainState } from "./projectors.js";
import { applyEvents } from "./projectors.js";
import { taskProgress } from "./task-graph.js";
import { createAssignedTask, type TaskInput } from "./tasks.js";
import { scopeContains } from "./team.js";
import { type WorkspaceActor, workspaceAuthority } from "./workspace-shape.js";

export function companyAccess(state: DomainState, actor: WorkspaceActor, projectId: string) {
  const authority = workspaceAuthority(state, actor);
  const ownsInitiative = state.initiativeRecord?.some(
    (r) =>
      r.projectId === projectId && r.managerThreadId === actor.threadId && r.state === "active",
  );
  if (
    !ownsInitiative &&
    (!authority ||
      (!authority.all &&
        !authority.scopes.some((scope) =>
          scope.type === "project"
            ? scope.id === projectId
            : state.subproject?.some((r) => r.id === scope.id && r.projectId === projectId),
        )))
  )
    throw Error("company_scope_required");
  if (!state.project?.some((r) => r.id === projectId && !r.archived))
    throw Error("project_unavailable");
}
export function saveInitiative(
  state: DomainState,
  value: InitiativeRecord,
  context: CommandContext,
): Outcome {
  parse(InitiativeRecordSchema, value);
  if (!state.project?.some((r) => r.id === value.projectId && !r.archived))
    throw Error("project_unavailable");
  if (
    value.teamId &&
    !state.subproject?.some(
      (r) => r.id === value.teamId && r.projectId === value.projectId && !r.archived,
    )
  )
    throw Error("team_unavailable");
  if (
    value.managerThreadId &&
    !state.thread?.some(
      (r) =>
        r.id === value.managerThreadId &&
        (r.projectId === value.projectId ||
          state.settings?.some((s) => s.key === "chief.thread" && s.value === r.id)) &&
        !r.archived,
    )
  )
    throw Error("owner_unavailable");
  const old = state.initiativeRecord?.find((r) => r.id === value.id);
  if (old && (old.projectId !== value.projectId || value.version !== Number(old.version) + 1))
    throw Error("stale_initiative");
  if (!old && value.version !== 1) throw Error("stale_initiative");
  if (
    value.state === "completed" &&
    state.task?.some(
      (r) => r.initiativeId === value.id && !["completed", "cancelled"].includes(String(r.state)),
    )
  )
    throw Error("initiative_has_open_work");
  return old
    ? companyRecord("initiativeRecord", value, context)
    : handle(state, { type: "create", kind: "initiativeRecord", value }, context);
}
export function saveRemit(
  state: DomainState,
  value: ManagerRemit,
  context: CommandContext,
): Outcome {
  parse(ManagerRemitSchema, value);
  if (
    !state.thread?.some(
      (r) => r.id === value.threadId && r.projectId === value.projectId && !r.archived,
    )
  )
    throw Error("owner_unavailable");
  if (value.id !== value.threadId) throw Error("remit_id_must_match_chat");
  const old = state.managerRemit?.find((r) => r.id === value.id);
  if (value.version !== (old ? Number(old.version) + 1 : 1)) throw Error("stale_remit");
  return old
    ? companyRecord("managerRemit", value, context)
    : handle(state, { type: "create", kind: "managerRemit", value }, context);
}

export function proposeCompanyPlan(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  input: Pick<CompanyPlan, "id" | "projectId" | "title" | "explanation" | "changes" | "authority">,
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") {
    if (!actor) throw Error("company_scope_required");
    companyAccess(state, actor, input.projectId);
  }
  if (!state.project?.some((r) => r.id === input.projectId && !r.archived))
    throw Error("project_unavailable");
  const previous = state.companyPlan?.find((r) => r.id === input.id);
  if (previous) throw Error("plan_id_exists: propose a new version with a new id");
  // Dry-run through the same rules used at approval. No side effects escape this outcome.
  const preview = applyCompanyChanges(state, input.projectId, input.changes, {
    ...context,
    actor: { kind: "human", id: "preview" },
  });
  if (actor && context.actor.kind !== "human") {
    const authority = workspaceAuthority(state, actor);
    const covers = (node: unknown) =>
      authority?.all ||
      authority?.scopes.some((scope) => scopeContains(preview.state, scope, node));
    for (const change of input.changes) {
      const record = "value" in change ? change.value : undefined;
      const node =
        "parent" in change ? change.parent : record && "node" in record ? record.node : undefined;
      const teamId = record && "teamId" in record ? record.teamId : undefined;
      const threadId = record && "threadId" in record ? record.threadId : undefined;
      const existing =
        "id" in change
          ? (preview.state.subproject?.find((r) => r.id === change.id) ??
            preview.state.thread?.find((r) => r.id === change.id) ??
            preview.state.task?.find((r) => r.id === change.id))
          : undefined;
      const targetScope =
        node ??
        (teamId
          ? { type: "subproject", id: teamId }
          : threadId
            ? preview.state.thread?.find((r) => r.id === threadId)?.node
            : (existing?.node ??
              (existing?.depth
                ? { type: "subproject", id: existing.id }
                : { type: "project", id: input.projectId })));
      if (!covers(targetScope)) throw Error("outside_workspace_scope");
      // Moving a node also requires authority over its original scope.
      if ("id" in change) {
        const original =
          state.thread?.find((r) => r.id === change.id) ??
          state.task?.find((r) => r.id === change.id);
        const team = state.subproject?.find((r) => r.id === change.id);
        if (original && !covers(original.node)) throw Error("outside_workspace_scope");
        if (
          team &&
          !authority?.all &&
          !authority?.scopes.some((scope) =>
            scopeContains(state, scope, { type: "subproject", id: team.id }),
          )
        )
          throw Error("outside_workspace_scope");
      }
    }
  }
  if (input.authority) {
    const initiative = preview.state.initiativeRecord?.find(
      (r) => r.id === input.authority?.initiativeId,
    );
    if (!initiative || initiative.projectId !== input.projectId)
      throw Error("authority_initiative_required");
  }
  const value: CompanyPlan = parse(CompanyPlanSchema, {
    ...input,
    version: 1,
    state: "proposed",
    baseline: companyBaseline(state, input.projectId, input.changes),
    preview: preview.preview,
    requestedBy: actor?.threadId ?? context.actor.id,
    createdAt: context.at,
  });
  return handle(state, { type: "create", kind: "companyPlan", value }, context);
}
export function decideCompanyPlan(
  state: DomainState,
  input: { id: string; version: number; baseline: string; approve: boolean },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw Error("human_approval_required");
  const plan = parse(
    CompanyPlanSchema,
    state.companyPlan?.find((r) => r.id === input.id),
  );
  if (
    plan.version !== input.version ||
    plan.baseline !== input.baseline ||
    plan.state !== "proposed"
  )
    throw Error("stale_plan");
  if (input.approve && companyBaseline(state, plan.projectId, plan.changes) !== plan.baseline)
    throw Error("stale_plan: organization or work changed; request a fresh proposal");
  const result = input.approve
    ? applyCompanyChanges(state, plan.projectId, plan.changes, context)
    : { state, events: [] };
  const { id: _id, ...changes } = {
    ...plan,
    state: input.approve ? "applied" : "declined",
    approvedBy: context.actor.id,
    approvedAt: context.at,
  };
  // Exact-version plan bodies never change; only the decision metadata is updated.
  const event = handle(
    result.state,
    {
      type: "update",
      kind: "companyPlan",
      id: plan.id,
      changes: { approvedBy: changes.approvedBy, approvedAt: changes.approvedAt },
    },
    context,
  ).events[0];
  if (!event) throw Error("plan_event_missing");
  const events = [...result.events, { ...event, payload: { ...plan, ...changes, id: plan.id } }];
  if (input.approve) {
    const recipients = new Set<string>();
    for (const change of plan.changes) {
      if (change.kind === "chat" && change.manager) recipients.add(change.id);
      if (change.kind === "assignManager" || change.kind === "moveChat") recipients.add(change.id);
      if (change.kind === "remit") recipients.add(change.value.threadId);
      if (change.kind === "initiative" && change.value.managerThreadId)
        recipients.add(change.value.managerThreadId);
      if (change.kind === "assignTask") recipients.add(change.accountableThreadId);
      if (["moveTeam", "renameTeam", "archiveTeam"].includes(change.kind) && "id" in change)
        for (const thread of result.state.thread ?? [])
          if (thread.kind === "manager" && thread.projectId === plan.projectId && !thread.archived)
            recipients.add(String(thread.id));
    }
    let delivered = applyEvents(state, events),
      index = 0;
    for (const threadId of recipients) {
      const id = `${plan.id}:change:${index++}`;
      const notice = queueSystemNotice(
        delivered,
        {
          threadId,
          text: `[Approved organization change] The human applied plan ${plan.id}: ${plan.title}. Read company_work for current ownership, responsibilities, inherited scope and work. Existing conversation history is historical context; current records describe your approved responsibility. Continue within existing authority; this notice grants no extra permissions.`,
        },
        id,
        {
          ...context,
          commandId: `${context.commandId}:notice:${index}`,
          actor: { kind: "system", id: "company" },
        },
      );
      events.push(...notice.events);
      delivered = applyEvents(delivered, notice.events);
    }
  }

  return {
    events: events.map((e, i) => ({ ...e, eventId: `${context.commandId}:${i}` })),
    result: { id: plan.id, state: changes.state },
  };
}
const levels = ["read_only", "workspace_write", "workspace_write_net", "full_access"];
export function assignCompanyTask(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  input: TaskInput,
  planId: string | undefined,
  context: CommandContext,
): Outcome {
  const projectId = scopeLineage(state, input.node).project.id;
  if (context.actor.kind !== "human") {
    if (!actor) throw Error("assignment_authority_required");
    const executingParent = state.task?.find(
      (r) =>
        r.id === input.parentId &&
        r.threadId === actor.threadId &&
        r.authorityPlanId === planId &&
        r.projectId === projectId &&
        r.state === "running" &&
        scopeContains(state, r.node, input.node),
    );
    if (!executingParent) companyAccess(state, actor, projectId);
    const plan = state.companyPlan?.find(
      (r) => r.id === planId && r.state === "applied" && r.projectId === projectId,
    );
    const authority = plan?.authority as CompanyPlan["authority"];
    if (!plan || !authority || input.initiativeId !== authority.initiativeId)
      throw Error("approved_authority_required");
    const owner = state.initiativeRecord?.find((r) => r.id === authority.initiativeId);
    if (!owner || owner.state !== "active") throw Error("initiative_not_active");
    const proposingChief =
      plan.requestedBy === actor.threadId &&
      state.settings?.some((r) => r.key === "chief.thread" && r.value === actor.threadId);
    if (!executingParent && owner.managerThreadId !== actor.threadId && !proposingChief)
      throw Error("initiative_owner_required");
    const profile = state.agent?.find((r) => r.id === input.profileId && !r.archived);
    const level = levels.indexOf(String(profile?.permissionProfile));
    if (level < 0 || level > levels.indexOf(authority.permissionCeiling))
      throw Error("assignment_permission_ceiling");
    const committed = (state.task ?? []).filter((r) => r.authorityPlanId === planId);
    if (committed.length >= authority.maxTasks) throw Error("assignment_task_limit");
    if (
      input.budgetUsd === undefined ||
      committed.reduce((sum, r) => sum + Number(r.budgetUsd ?? 0), 0) + input.budgetUsd >
        authority.budgetUsd
    )
      throw Error("assignment_budget_limit");
  }
  const initiative = state.initiativeRecord?.find((r) => r.id === input.initiativeId);
  const accountable = input.accountableThreadId ?? initiative?.managerThreadId;
  if (accountable) input = { ...input, accountableThreadId: String(accountable) };
  return createAssignedTask(
    state,
    { ...input, ...(planId ? { authorityPlanId: planId } : {}) },
    context,
  );
}
export function companyView(state: DomainState, projectId?: string) {
  const projects = (state.project ?? []).filter(
    (r) => !r.archived && (!projectId || r.id === projectId),
  );
  const ids = new Set(projects.map((r) => r.id));
  const tasks = (state.task ?? []).filter((r) => ids.has(r.projectId));
  const priorities = (state.initiativeRecord ?? [])
    .filter((r) => ids.has(r.projectId) && ["active", "review", "paused"].includes(String(r.state)))
    .map((r) => ({
      id: r.id,
      projectId: r.projectId,
      title: r.title,
      outcome: r.outcome,
      priority: r.priority,
      state: r.state,
      managerThreadId: r.managerThreadId,
      targetDate: r.targetDate,
      progress: taskProgress(
        state,
        tasks.filter((t) => t.initiativeId === r.id),
      ),
    }))
    .sort(
      (a, b) =>
        ["urgent", "high", "normal", "low"].indexOf(String(a.priority)) -
        ["urgent", "high", "normal", "low"].indexOf(String(b.priority)),
    );
  return {
    projects,
    priorities,
    teams: (state.subproject ?? []).filter((r) => ids.has(r.projectId) && !r.archived),
    managers: (state.thread ?? []).filter(
      (r) => ids.has(r.projectId) && r.kind === "manager" && !r.archived,
    ),
    remits: (state.managerRemit ?? []).filter((r) => ids.has(r.projectId)),
    initiatives: (state.initiativeRecord ?? [])
      .filter((r) => ids.has(r.projectId))
      .map((r) => ({
        ...parse(InitiativeRecordSchema, r),
        progress: taskProgress(
          state,
          tasks.filter((t) => t.initiativeId === r.id),
        ),
      })),
    tasks,
    plans: (state.companyPlan ?? []).filter((r) => ids.has(r.projectId)),
    briefs: (state.projectBrief ?? []).filter((r) => ids.has(r.projectId)),
    decisions: (state.interaction ?? []).filter(
      (r) =>
        r.state === "pending" &&
        state.thread?.some((t) => t.id === r.threadId && ids.has(t.projectId)),
    ),
  };
}
export function writeProjectBrief(
  state: DomainState,
  projectId: string,
  summary: string,
  context: CommandContext,
): Outcome {
  const view = companyView(state, projectId);
  if (!view.projects.length) throw Error("project_unavailable");
  const day = context.at.slice(0, 10);
  const revision =
    (state.projectBrief ?? []).filter((r) => r.projectId === projectId && r.day === day).length + 1;
  const value: ProjectBrief = {
    id: `${projectId}:${day}:${revision}`,
    projectId,
    day,
    revision,
    summary: (
      summary ||
      `${view.projects[0]?.name}: ${view.tasks.filter((t) => t.state === "completed").length} accepted, ${view.tasks.filter((t) => t.state === "review").length} awaiting review, ${view.tasks.filter((t) => ["failed", "blocked"].includes(String(t.state)) || t.holdReason).length} blocked or needing attention. Next commitments: ${
        view.tasks
          .filter((t) => !["completed", "cancelled"].includes(String(t.state)))
          .slice(0, 5)
          .map((t) => `${t.title} (${t.state})`)
          .join("; ") || "none"
      }. ${view.decisions.length} open decisions.`
    ).slice(0, 4000),
    evidence: {
      initiatives: view.initiatives,
      tasks: view.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        state: t.state,
        threadId: t.threadId,
        holdReason: t.holdReason,
        acceptance: t.acceptance,
      })),
      results: (state.taskResult ?? []).filter((r) => view.tasks.some((t) => t.id === r.taskId)),
      decisions: view.decisions.map((r) => ({ id: r.id, title: r.title })),
    },
    createdAt: context.at,
  };
  return handle(state, { type: "create", kind: "projectBrief", value }, context);
}

/** Ordinary result review can be delegated explicitly, while initiative acceptance stays human. */
export function reviewCompanyTask(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  input: {
    taskId: string;
    revision: number;
    decision: "accept" | "changes" | "reject";
    feedback?: string;
    planId?: string;
  },
  context: CommandContext,
): Outcome {
  const task = state.task?.find((r) => r.id === input.taskId);
  if (!task) throw Error("task_unavailable");
  if (context.actor.kind !== "human") {
    if (!actor || task.threadId === actor.threadId) throw Error("independent_reviewer_required");
    companyAccess(state, actor, String(task.projectId));
    const plan = state.companyPlan?.find(
      (r) => r.id === input.planId && r.state === "applied" && r.projectId === task.projectId,
    );
    const authority = plan?.authority as CompanyPlan["authority"];
    const initiative = state.initiativeRecord?.find((r) => r.id === task.initiativeId);
    if (
      !authority?.reviewTasks ||
      authority.initiativeId !== task.initiativeId ||
      initiative?.state !== "active" ||
      (initiative.managerThreadId !== actor.threadId &&
        !(
          plan?.requestedBy === actor.threadId &&
          state.settings?.some((r) => r.key === "chief.thread" && r.value === actor.threadId)
        ))
    )
      throw Error("review_authority_required");
  }
  const reviewed = handle(
    state,
    {
      type: "review",
      id: input.taskId,
      revision: input.revision,
      decision: input.decision,
      ...(input.feedback ? { feedback: input.feedback } : {}),
    },
    context,
  );
  return reviewed;
}
