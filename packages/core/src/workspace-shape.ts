import {
  type PermissionProfile,
  parse,
  type Scope,
  ScopeSchema,
  type Thread,
  ThreadSchema,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { createDirection, createScopedChat, scopeLineage } from "./hierarchy.js";
import { applyEvents, type DomainState } from "./projectors.js";

/** D119. Agent requests to shape the workspace. Authority comes from stored state, never arguments. */
export type WorkspaceRequest =
  | { tool: "create"; kind: "project"; name: string; goal?: string }
  | {
      tool: "create";
      kind: "subproject";
      name: string;
      parent: Scope;
      label?: string;
      goal?: string;
    }
  | {
      tool: "create";
      kind: "chat";
      title: string;
      parent: Scope;
      profileId?: string;
      manager?: boolean;
    }
  | {
      tool: "update";
      target: { type: "project" | "subproject" | "chat" | "profile"; id: string };
      changes: Record<string, string>;
    };
export interface WorkspaceActor {
  agentId: string;
  threadId: string;
}
export interface WorkspaceAuthority {
  all: boolean;
  scopes: Scope[];
}
const permissions: PermissionProfile[] = [
  "read_only",
  "workspace_write",
  "workspace_write_net",
  "full_access",
];
const editable = {
  project: ["name", "goal", "instructions", "constraints"],
  subproject: ["name", "goal", "instructions"],
  chat: ["title"],
  profile: ["name", "model", "effort", "instructions", "permissionProfile"],
} as const;

export function workspaceAuthority(
  state: DomainState,
  actor: WorkspaceActor,
): WorkspaceAuthority | undefined {
  const thread = state.thread?.find(
    (row) => row.id === actor.threadId && row.agentId === actor.agentId && !row.archived,
  );
  const profile = state.agent?.find((row) => row.id === actor.agentId && !row.archived);
  if (!thread || !profile) return undefined;
  const scopes: Scope[] = [];
  let all = profile.kind === "chief_of_staff";
  if (thread.kind === "manager" && thread.node) scopes.push(parse(ScopeSchema, thread.node));
  for (const grant of state.grant ?? []) {
    if (
      grant.holderAgentId !== actor.agentId ||
      grant.capability !== "workspace_shape" ||
      grant.revokedAt !== undefined
    )
      continue;
    if (grant.target === "*") all = true;
    else scopes.push({ type: "project", id: String(grant.target) });
  }
  return all || scopes.length ? { all, scopes } : undefined;
}
function covers(state: DomainState, authority: WorkspaceAuthority, scope: unknown) {
  const lineage = scopeLineage(state, scope);
  if (authority.all) return lineage;
  const ok = authority.scopes.some((held) =>
    held.type === "project"
      ? held.id === lineage.project.id
      : lineage.directions.some((direction) => direction.id === held.id),
  );
  if (!ok) throw new Error("outside_workspace_scope");
  return lineage;
}
function level(value: unknown) {
  const index = permissions.indexOf(value as PermissionProfile);
  if (index < 0) throw new Error("invalid_permission_profile");
  return index;
}
function name(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 150)
    throw new Error("invalid_scope_name");
  return value.trim();
}
function nodeOf(thread: Record<string, unknown>): Scope {
  if (thread.node) return parse(ScopeSchema, thread.node);
  if (typeof thread.projectId === "string") return { type: "project", id: thread.projectId };
  throw new Error("outside_workspace_scope");
}

/** Returns the reasons a human must approve the request. An empty list runs directly. */
export function planWorkspaceChange(
  state: DomainState,
  actor: WorkspaceActor,
  request: WorkspaceRequest,
): string[] {
  const authority = workspaceAuthority(state, actor);
  if (!authority) throw new Error("grant_required");
  if (request.tool === "create" && request.kind === "project") {
    name(request.name);
    if (
      state.project?.some(
        (row) =>
          !row.archived &&
          String(row.name).trim().toLowerCase() === request.name.trim().toLowerCase(),
      )
    )
      throw new Error("duplicate_scope_name");
    return ["new_project"];
  }
  if (request.tool === "create" && request.kind === "subproject") {
    name(request.name);
    const lineage = covers(state, authority, request.parent);
    const depth = lineage.directions.length + 1;
    if (depth > 3) throw new Error("hierarchy_too_deep");
    return depth > lineage.project.hierarchyDepth ? ["deeper_hierarchy"] : [];
  }
  if (request.tool === "create") {
    name(request.title);
    covers(state, authority, request.parent);
    const caller = state.agent?.find((row) => row.id === actor.agentId);
    const profile = state.agent?.find(
      (row) => row.id === (request.profileId ?? actor.agentId) && !row.archived,
    );
    if (!profile || profile.hidden) throw new Error("profile_unavailable");
    const reasons: string[] = [];
    if (request.manager) reasons.push("manager_assignment");
    if (level(profile.permissionProfile) > level(caller?.permissionProfile))
      reasons.push("permission_widening");
    return reasons;
  }
  const { target, changes } = request;
  const keys = Object.keys(changes);
  const allowed: readonly string[] = editable[target.type];
  if (!keys.length || keys.some((key) => !allowed.includes(key)))
    throw new Error("invalid_workspace_change");
  for (const key of keys)
    if (typeof changes[key] !== "string" || String(changes[key]).length > 4000)
      throw new Error("invalid_workspace_change");
  if (target.type === "profile") {
    const profile = state.agent?.find((row) => row.id === target.id && !row.archived);
    if (!profile) throw new Error("profile_unavailable");
    if (keys.includes("name")) name(changes.name);
    const narrowing =
      keys.length === 1 &&
      keys[0] === "permissionProfile" &&
      level(changes.permissionProfile) < level(profile.permissionProfile);
    return narrowing ? [] : ["profile_change"];
  }
  if (keys.includes("name")) name(changes.name);
  if (keys.includes("title")) name(changes.title);
  if (target.type === "chat") {
    const thread = state.thread?.find((row) => row.id === target.id && !row.archived);
    if (!thread) throw new Error("thread_unavailable");
    covers(state, authority, nodeOf(thread));
    return [];
  }
  covers(state, authority, { type: target.type, id: target.id });
  return keys.some((key) => key === "instructions" || key === "constraints")
    ? ["shared_instructions"]
    : [];
}

function renumber(events: Outcome["events"], context: CommandContext) {
  return events.map((event, index) => ({ ...event, eventId: `${context.commandId}:${index}` }));
}
/**
 * Applies a planned request. Gated requests run only with approved true and a human actor,
 * which also satisfies the confirmation the core commands require for managers and widening.
 */
export function applyWorkspaceChange(
  state: DomainState,
  actor: WorkspaceActor,
  request: WorkspaceRequest,
  id: string,
  context: CommandContext,
  approval?: { interactionId: string },
): Outcome {
  const reasons = planWorkspaceChange(state, actor, request);
  const approved = approval !== undefined && context.actor.kind === "human";
  if (reasons.length && !approved) throw new Error("approval_required");
  let change: Outcome;
  let created: { kind: string; id: string } | undefined;
  if (request.tool === "create" && request.kind === "project") {
    change = handle(
      state,
      {
        type: "create",
        kind: "project",
        value: {
          id,
          name: request.name.trim(),
          goal: request.goal ?? "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 0,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: context.at,
        },
      },
      context,
    );
    created = { kind: "project", id };
  } else if (request.tool === "create" && request.kind === "subproject") {
    const lineage = scopeLineage(state, request.parent);
    change = createDirection(
      state,
      {
        id,
        projectId: lineage.project.id,
        ...(request.parent.type === "subproject" ? { parentId: request.parent.id } : {}),
        name: request.name.trim(),
        label: request.label?.trim() || "Team",
        goal: request.goal ?? "",
        instructions: "",
        depth: lineage.directions.length + 1,
        archived: false,
        createdAt: context.at,
      },
      context,
    );
    created = { kind: "subproject", id };
  } else if (request.tool === "create") {
    const lineage = scopeLineage(state, request.parent);
    const thread: Thread = parse(ThreadSchema, {
      id,
      agentId: request.profileId ?? actor.agentId,
      projectId: lineage.project.id,
      node: request.parent,
      kind: request.manager ? "manager" : "side",
      title: request.title.trim(),
      titleSource: "auto",
      pinned: false,
      archived: false,
      createdAt: context.at,
      lastActivityAt: context.at,
    });
    change = createScopedChat(state, thread, context, approved);
    created = { kind: "chat", id };
  } else {
    const kind =
      request.target.type === "chat"
        ? "thread"
        : request.target.type === "profile"
          ? "agent"
          : request.target.type;
    change = handle(
      state,
      {
        type: "update",
        kind,
        id: request.target.id,
        changes: { ...request.changes },
        ...(approved ? { confirmed: true } : {}),
      },
      context,
    );
  }
  const audit = handle(
    applyEvents(state, change.events),
    {
      type: "create",
      kind: "audit",
      value: {
        id: `${context.commandId}:audit`,
        actor: context.actor,
        action: `workspace.${request.tool}`,
        target: created?.id ?? (request.tool === "update" ? request.target.id : id),
        result: "allowed",
        detail: {
          requestedBy: actor.agentId,
          threadId: actor.threadId,
          kind: request.tool === "create" ? request.kind : request.target.type,
          ...(approval ? { interactionId: approval.interactionId, confirmed: true } : {}),
        },
        at: context.at,
      },
    },
    context,
  );
  return {
    events: renumber([...change.events, ...audit.events], context),
    result: created ?? {
      kind: request.tool === "update" ? request.target.type : "",
      id: request.tool === "update" ? request.target.id : id,
    },
  };
}

/** A bounded view of what the actor can shape. Ids let the agent address scopes without guessing. */
export function readWorkspace(state: DomainState, actor: WorkspaceActor, projectId?: string) {
  const authority = workspaceAuthority(state, actor);
  if (!authority) throw new Error("grant_required");
  const visible = (scope: Scope) => {
    try {
      covers(state, authority, scope);
      return true;
    } catch {
      return false;
    }
  };
  const projects = (state.project ?? []).filter(
    (row) =>
      !row.archived &&
      (!projectId || row.id === projectId) &&
      (authority.all ||
        visible({ type: "project", id: String(row.id) }) ||
        (state.subproject ?? []).some(
          (sub) => sub.projectId === row.id && visible({ type: "subproject", id: String(sub.id) }),
        )),
  );
  const ids = new Set(projects.map((row) => row.id));
  return {
    canCreateProject: true,
    projects: projects.map((row) => ({
      id: row.id,
      name: row.name,
      depth: row.hierarchyDepth,
      editable: visible({ type: "project", id: String(row.id) }),
    })),
    subprojects: (state.subproject ?? [])
      .filter((row) => !row.archived && ids.has(row.projectId))
      .map((row) => ({
        id: row.id,
        projectId: row.projectId,
        ...(row.parentId ? { parentId: row.parentId } : {}),
        name: row.name,
        depth: row.depth,
        editable: visible({ type: "subproject", id: String(row.id) }),
      })),
    chats: (state.thread ?? [])
      .filter((row) => !row.archived && ids.has(row.projectId))
      .map((row) => ({ id: row.id, title: row.title, kind: row.kind, node: row.node })),
    profiles: (state.agent ?? [])
      .filter((row) => !row.archived && !row.hidden)
      .map((row) => ({ id: row.id, name: row.name, permission: row.permissionProfile })),
  };
}
