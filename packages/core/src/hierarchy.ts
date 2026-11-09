import {
  type Project,
  ProjectSchema,
  parse,
  type Scope,
  ScopeSchema,
  type Subproject,
  SubprojectSchema,
  type Thread,
  ThreadSchema,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { applyEvents, type DomainState } from "./projectors.js";

export function scopeLineage(
  state: DomainState,
  input: unknown,
): { project: Project; directions: Subproject[] } {
  const scope = parse(ScopeSchema, input);
  const directions: Subproject[] = [];
  let projectId = scope.id;
  if (scope.type === "subproject") {
    const visited = new Set<string>();
    let current: string | undefined = scope.id;
    while (current) {
      const row = state.subproject?.find((entry) => entry.id === current && !entry.archived);
      if (!row || visited.has(current) || directions.length === 3)
        throw new Error("scope_unavailable");
      const direction = parse(SubprojectSchema, row);
      if (
        directions.length &&
        (directions[0]?.projectId !== direction.projectId ||
          directions[0]?.depth !== direction.depth + 1)
      )
        throw new Error("scope_unavailable");
      visited.add(current);
      directions.unshift(direction);
      current = direction.parentId;
    }
    if (directions[0]?.depth !== 1) throw new Error("scope_unavailable");
    projectId = directions[0].projectId;
  } else if (scope.type !== "project") throw new Error("scope_unavailable");
  const row = state.project?.find((entry) => entry.id === projectId && !entry.archived);
  if (!row) throw new Error("scope_unavailable");
  const project = parse(ProjectSchema, row);
  if (directions.length > project.hierarchyDepth) throw new Error("scope_unavailable");
  return structuredClone({ project, directions });
}
function events(output: Outcome, context: CommandContext): Outcome {
  return {
    ...output,
    events: output.events.map((event, index) => ({
      ...event,
      eventId: `${context.commandId}:${index}`,
    })),
  };
}
function validName(name: string) {
  if (!name.trim() || name.length > 150) throw new Error("invalid_scope_name");
}
export function createDirection(
  state: DomainState,
  input: unknown,
  context: CommandContext,
): Outcome {
  const value = parse(SubprojectSchema, input);
  validName(value.name);
  const scope: Scope = value.parentId
    ? { type: "subproject", id: value.parentId }
    : { type: "project", id: value.projectId };
  const parent = scopeLineage(state, scope);
  if (parent.project.id !== value.projectId || value.depth !== parent.directions.length + 1)
    throw new Error("invalid_hierarchy");
  if (
    state.subproject?.some(
      (row) =>
        !row.archived &&
        row.projectId === value.projectId &&
        row.parentId === value.parentId &&
        String(row.name).trim().toLowerCase() === value.name.trim().toLowerCase(),
    )
  )
    throw new Error("duplicate_scope_name");
  const expanded =
    parent.project.hierarchyDepth < value.depth
      ? handle(
          state,
          {
            type: "update",
            kind: "project",
            id: value.projectId,
            changes: { hierarchyDepth: value.depth },
          },
          context,
        )
      : { events: [], result: {} };
  const created = handle(
    applyEvents(state, expanded.events),
    { type: "create", kind: "subproject", value },
    context,
  );
  return events({ ...created, events: [...expanded.events, ...created.events] }, context);
}
function sameScope(a: unknown, b: Scope): boolean {
  if (!a || typeof a !== "object") return false;
  const scope = a as Record<string, unknown>;
  return scope.type === b.type && scope.id === b.id;
}
export function createScopedChat(
  state: DomainState,
  input: unknown,
  context: CommandContext,
  confirmed = false,
): Outcome {
  const value: Thread = parse(ThreadSchema, input);
  if (!state.agent?.some((row) => row.id === value.agentId && !row.archived))
    throw new Error("profile_unavailable");
  if (value.node) {
    const lineage = scopeLineage(state, value.node);
    if (value.projectId !== lineage.project.id) throw new Error("scope_project_mismatch");
  } else if (value.kind === "manager") throw new Error("scope_required");
  else if (value.projectId) scopeLineage(state, { type: "project", id: value.projectId });
  if (value.kind === "manager") {
    if (!confirmed || context.actor.kind !== "human") throw new Error("confirmation_required");
    if (
      state.thread?.some(
        (row) =>
          !row.archived && row.kind === "manager" && sameScope(row.node, value.node as Scope),
      )
    )
      throw new Error("manager_already_assigned");
  }
  const created = handle(state, { type: "create", kind: "thread", value }, context);
  if (value.kind !== "manager") return created;
  const audit = handle(
    applyEvents(state, created.events),
    {
      type: "create",
      kind: "audit",
      value: {
        id: value.id,
        actor: context.actor,
        action: "manager.assign",
        target: value.id,
        result: "allowed",
        detail: { scope: value.node, profileId: value.agentId, confirmed: true },
        at: context.at,
      },
    },
    context,
  );
  return events({ ...created, events: [...created.events, ...audit.events] }, context);
}
