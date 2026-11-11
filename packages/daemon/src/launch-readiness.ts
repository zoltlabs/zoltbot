import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { type DomainState, scopeLineage, taskReady } from "@zoltbot/core";
import {
  buildKnowledgePack,
  defaultUserBudget,
  eligibleKnowledge,
  knowledgeMatches,
} from "@zoltbot/knowledge";
import { ProfileSchema, parse, ScopeSchema, type Task, ThreadSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { createArtifactBinding } from "./artifacts/binding.js";
import { chiefThreadId, leadIdeasInstruction } from "./chief/identity.js";
import { connectionsRuntime } from "./connections-runtime.js";
import {
  artifactBrowserToolDefinitions,
  artifactRuntimeToolDefinitions,
  indirectRuntimeToolDefinitions,
  managerArtifactBrowserToolDefinitions,
  managerArtifactToolDefinitions,
} from "./runtime-tools.js";
import { skillsRuntime } from "./skills-runtime.js";

export interface TaskLaunchReadiness {
  ready: boolean;
  limit: number;
  fixed: number;
  connections: number;
  skills: number;
  knowledge: number;
  remaining: number;
  requiredKnowledgeIds?: string[];
  optionalKnowledgeIds?: string[];
  excludedKnowledgeIds?: string[];
  overflowIds?: string[];
  blocker?: string;
}

export function taskLaunchReadiness(
  store: Store,
  state: DomainState,
  task: Task,
): TaskLaunchReadiness {
  const limit = 1500;
  const profileRow = state.agent?.find((r) => r.id === task.ownerAgentId && !r.archived);
  const profile = profileRow ? parse(ProfileSchema, profileRow) : undefined;
  const threadRow = task.threadId
    ? state.thread?.find((r) => r.id === task.threadId && !r.archived)
    : undefined;
  const isManager =
    threadRow?.kind === "manager" ||
    state.initiativeRecord?.some(
      (r) =>
        r.managerThreadId === task.threadId &&
        !["completed", "cancelled"].includes(String(r.state)),
    ) === true ||
    (!!task.threadId && task.accountableThreadId === task.threadId);
  const hasBrowser = !!task.browser;
  const hostTools = hasBrowser
    ? isManager
      ? managerArtifactBrowserToolDefinitions
      : artifactBrowserToolDefinitions
    : [
        ...(isManager ? managerArtifactToolDefinitions : artifactRuntimeToolDefinitions),
        ...indirectRuntimeToolDefinitions,
      ];
  const lineage = task.node ? safeLineage(state, task.node) : undefined;
  const workspaceText = lineage
    ? [lineage.project, ...lineage.directions]
        .map((row, index) => {
          const parts = [
            row.goal ? `Goal: ${row.goal}` : "",
            row.instructions ? `Instructions: ${row.instructions}` : "",
            "constraints" in row && row.constraints ? `Constraints: ${row.constraints}` : "",
          ].filter(Boolean);
          return parts.length
            ? `${index ? "Team" : "Workspace"}: ${row.name}\n${parts.join("\n")}`
            : "";
        })
        .filter(Boolean)
        .join("\n\n")
    : "";
  const ideas =
    lineage && threadRow?.kind === "manager" && chiefThreadId(state) ? leadIdeasInstruction : "";
  const artifactGuidance = createArtifactBinding("/workspace").guidanceText;
  const instructions = [
    profile?.roleText,
    profile?.instructions,
    artifactGuidance,
    [workspaceText, ideas].filter(Boolean).join("\n\n"),
  ]
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n\n");
  const fixed =
    referenceTokenEstimate(instructions) + referenceTokenEstimate(JSON.stringify(hostTools));
  const availableConnections = profile
    ? connectionsRuntime(store).select(task.projectId, profile.id, true)
    : [];
  const routineConnIds = (task.routineInputs as { connections?: string[] } | undefined)
    ?.connections;
  const selectedConnections = Array.isArray(routineConnIds)
    ? availableConnections.filter((c) => routineConnIds.includes(c.id))
    : availableConnections;
  const connections = selectedConnections.reduce((n, c) => n + c.schemaTokens.value, 0);
  const syntheticThread = threadRow
    ? parse(ThreadSchema, threadRow)
    : parse(ThreadSchema, {
        id: task.threadId ?? `${task.id}:preview`,
        title: task.title,
        agentId: task.ownerAgentId,
        projectId: task.projectId,
        node: task.node,
        taskId: task.id,
        archived: false,
        pinned: false,
        status: "idle",
        unreadCount: 0,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      });
  const selectedSkills = profile
    ? skillsRuntime(store, "/runtime").select({ thread: syntheticThread, profile })
    : [];
  const skills = selectedSkills.reduce((n, s) => n + s.wrapperTokens, 0);
  const browserReserve = hasBrowser ? 600 : 0;
  const remaining = Math.max(0, limit - fixed - connections - skills - browserReserve);

  const scope = parse(ScopeSchema, { type: "task", id: task.id });
  const eligible = eligibleKnowledge(state, scope).filter((k) => k.status === "active");
  const eligibleIds = new Set(eligible.map((k) => k.id));
  const settingExclusions =
    (
      state.settings?.find((r) => r.key === `knowledge.exclusions.${task.id}`)?.value as
        | { ids?: string[] }
        | undefined
    )?.ids ?? [];
  const explicitExclusions = [
    ...new Set([...settingExclusions, ...(task.excludedKnowledgeIds ?? [])]),
  ];
  const exclusionSet = new Set(explicitExclusions);
  const initiative = task.initiativeId
    ? state.initiativeRecord?.find((r) => r.id === task.initiativeId)
    : undefined;
  const initiativeRequired = ((initiative?.knowledgeIds as string[] | undefined) ?? []).filter(
    (id) => eligibleIds.has(id),
  );
  const project = state.project?.find((p) => p.id === task.projectId);
  const designRequired =
    ["page", "design"].includes(String(task.outputMode)) &&
    project?.artifactDesignContextId &&
    eligibleIds.has(String(project.artifactDesignContextId))
      ? [String(project.artifactDesignContextId)]
      : [];
  const protectedSet = new Set([
    ...initiativeRequired,
    ...designRequired,
    ...eligible.filter((k) => k.pinned === true || k.kind === "constraint").map((k) => k.id),
  ]);
  const routineSelected = (task.routineInputs as { knowledge?: string[] } | undefined)?.knowledge;
  const excludedIds = [
    ...explicitExclusions,
    ...(Array.isArray(routineSelected)
      ? eligible.filter((row) => !routineSelected.includes(row.id)).map((row) => row.id)
      : []),
  ];
  const selectedOptionalIds = Array.isArray(routineSelected)
    ? routineSelected.filter(
        (id) => eligibleIds.has(id) && !exclusionSet.has(id) && !protectedSet.has(id),
      )
    : [];
  const requiredForPack = [
    ...new Set([...initiativeRequired, ...designRequired, ...selectedOptionalIds]),
  ];
  const rawUserBudget = state.settings?.find(
    (r) => r.key === `knowledge.userBudget.${task.projectId}`,
  )?.value;
  const userBudget =
    Number.isSafeInteger(rawUserBudget) && Number(rawUserBudget) >= 0
      ? Number(rawUserBudget)
      : defaultUserBudget;
  const pack = buildKnowledgePack(
    state,
    {
      id: `readiness-${task.id}`,
      taskId: task.id,
      revision: task.revision,
      scope,
      query: task.brief,
      at: task.updatedAt,
      remainingTokens: remaining,
      excludedIds,
      requiredIds: requiredForPack,
      userBudget,
    },
    knowledgeMatches(store, state, scope, task.brief),
  );
  const requiredKnowledgeIds = [...protectedSet].filter((id) => !exclusionSet.has(id));
  const optionalKnowledgeIds = [
    ...new Set([
      ...selectedOptionalIds,
      ...pack.pack.included.map((i) => i.id).filter((id) => !protectedSet.has(id)),
    ]),
  ];
  const overflowIds = [...new Set([...pack.pinnedOverflow, ...pack.requiredOverflow])];
  const graphHold = taskReady(state, task);
  const blocker = !profile
    ? "owner_profile_unavailable"
    : task.planned
      ? "planned_awaiting_dispatch"
      : graphHold
        ? graphHold
        : fixed > limit
          ? "injection_fixed_budget_exceeded"
          : fixed + connections + skills > limit
            ? "connections_or_skills_exceed_budget"
            : pack.held
              ? overflowIds.some((id) => protectedSet.has(id))
                ? `required_knowledge_exceeds_budget: ${overflowIds.filter((id) => protectedSet.has(id)).join(", ")}`
                : `optional_knowledge_exceeds_budget: ${overflowIds.join(", ")}`
              : task.holdReason
                ? task.holdReason
                : undefined;

  return {
    ready: blocker === undefined,
    limit,
    fixed,
    connections,
    skills,
    knowledge: pack.pack.tokenEstimate,
    remaining,
    ...(requiredKnowledgeIds.length ? { requiredKnowledgeIds } : {}),
    ...(optionalKnowledgeIds.length ? { optionalKnowledgeIds } : {}),
    ...(explicitExclusions.length ? { excludedKnowledgeIds: explicitExclusions } : {}),
    ...(overflowIds.length ? { overflowIds } : {}),
    ...(blocker ? { blocker } : {}),
  };
}

function safeLineage(state: DomainState, node: unknown) {
  try {
    return scopeLineage(state, node);
  } catch {
    return undefined;
  }
}
