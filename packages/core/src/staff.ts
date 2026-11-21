import {
  parse,
  type Scope,
  type StaffAllowance,
  StaffAllowanceSchema,
  type StaffField,
  type StaffPreview,
  type StaffRequest,
  StaffRequestSchema,
  staffAllowanceKey,
} from "@zoltbot/protocol";
import { agentTemplate } from "./agent-templates/index.js";
import { scopeLineage } from "./hierarchy.js";
import type { DomainState } from "./projectors.js";
import { managerAbove, scopeContains } from "./team.js";
import { type WorkspaceActor, workspaceAuthority } from "./workspace-shape.js";

/**
 * Planning for staff requests: who may ask, what a request would do and whether the owner must
 * approve it. Applying lives in `staff-apply.ts`, which re-runs this plan inside the same store
 * dispatch, so a stale approval cannot apply a request that no longer fits.
 */
type Row = Record<string, unknown>;
const permissions = ["read_only", "workspace_write", "workspace_write_net", "full_access"];
const level = (value: unknown) => permissions.indexOf(String(value));
const text = (value: unknown) => (typeof value === "string" ? value : "");
const ACTIVE = ["queued", "running", "blocked", "review"];
export const STAFF_DEFAULT_OFFER = 2;

export function readStaffAllowance(
  state: DomainState,
  threadId: string,
): StaffAllowance | undefined {
  const row = state.settings?.find((r) => r.key === staffAllowanceKey(threadId));
  try {
    const value = row ? parse(StaffAllowanceSchema, row.value) : undefined;
    return value?.threadId === threadId ? value : undefined;
  } catch {
    return undefined;
  }
}
const isChief = (state: DomainState, threadId: string) =>
  state.settings?.some((r) => r.key === "chief.thread" && r.value === threadId) ?? false;
function live(state: DomainState, id: string | undefined) {
  return id ? state.thread?.find((r) => r.id === id && !r.archived) : undefined;
}
const nodeOf = (thread: Row): Scope | undefined =>
  (thread.node as Scope | undefined) ??
  (typeof thread.projectId === "string" ? { type: "project", id: thread.projectId } : undefined);
function teamName(state: DomainState, node: Scope | undefined) {
  try {
    const lineage = scopeLineage(state, node);
    return String((lineage.directions.at(-1) ?? lineage.project).name);
  } catch {
    return "";
  }
}
/** An employee is a chat (or team manager) in a project; never the chief or a task's own chat. */
export function staffMember(state: DomainState, threadId: string): Row {
  const thread = live(state, threadId);
  if (!thread || !["side", "manager"].includes(String(thread.kind)) || !thread.projectId)
    throw Error("employee_unavailable");
  if (isChief(state, threadId)) throw Error("employee_unavailable");
  return thread;
}
/** Throws unless an agent may shape staff at `node`. The owner (no actor) may shape any. */
function requireScope(state: DomainState, actor: WorkspaceActor | undefined, node: unknown) {
  if (!actor) return;
  const authority = workspaceAuthority(state, actor);
  if (!authority) throw Error("staff_scope_required");
  if (authority.all) return;
  if (!authority.scopes.some((scope) => scopeContains(state, scope, node)))
    throw Error("staff_outside_scope");
}
const folderWithin = (folder: string, allowed: string) => {
  const clean = (value: string) => value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  return clean(folder) === clean(allowed) || clean(folder).startsWith(`${clean(allowed)}/`);
};
/** True when the manager's standing allowance covers adding this employee. */
export function allowanceCovers(
  allowance: StaffAllowance | undefined,
  projectId: string,
  model: string,
  folders: string[],
): boolean {
  if (!allowance || allowance.projectId !== projectId || allowance.used >= allowance.max)
    return false;
  if (allowance.models.length && !allowance.models.includes(model)) return false;
  if (!allowance.folders.length) return true;
  return (
    folders.length > 0 &&
    folders.every((folder) => allowance.folders.some((allowed) => folderWithin(folder, allowed)))
  );
}

export interface StaffPlan {
  reasons: string[];
  preview: StaffPreview;
  /** Set when a standing allowance lets an add run without asking. */
  allowance?: StaffAllowance;
  /** Resolved values the apply step uses. */
  resolved: Row;
}
const field = (label: string, before?: string, after?: string): StaffField => ({
  label,
  ...(before ? { before: before.slice(0, 4000) } : {}),
  ...(after ? { after: after.slice(0, 4000) } : {}),
});
const name = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 150) throw Error("invalid_employee_name");
  return trimmed;
};
/** The instructions a new employee starts with: its role, the folders it may edit, then any extra. */
export function employeeInstructions(role: string, folders: string[], extra: string) {
  return [
    role.trim() ? `Your role: ${role.trim()}` : "",
    folders.length ? `Edit files only in: ${folders.join(", ")}.` : "",
    extra.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function planAdd(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  request: Extract<StaffRequest, { kind: "add" }>,
): StaffPlan {
  const requester = actor ? live(state, actor.threadId) : undefined;
  if (actor && !requester) throw Error("staff_scope_required");
  const node: Scope | undefined = request.teamId
    ? { type: "subproject", id: request.teamId }
    : requester
      ? nodeOf(requester)
      : undefined;
  if (!node) throw Error("team_required");
  const lineage = scopeLineage(state, node);
  requireScope(state, actor, node);
  const manager =
    requester ??
    state.thread?.find(
      (r) =>
        !r.archived &&
        r.kind === "manager" &&
        (r.node as Scope | undefined)?.type === node.type &&
        (r.node as Scope | undefined)?.id === node.id,
    );
  const templateId = request.profileId ?? text(manager?.agentId);
  const template = state.agent?.find((r) => r.id === templateId && !r.archived && !r.hidden);
  if (!template) throw Error("profile_unavailable");
  const starter = request.templateId ? agentTemplate(request.templateId) : undefined;
  if (request.templateId && (!starter || (actor && !starter.managerFriendly)))
    throw Error("agent_template_unavailable");
  const role = request.role.trim() || starter?.role || "";
  const extra = request.instructions ?? starter?.instructions ?? "";
  const employee = name(request.name);
  if (
    state.thread?.some(
      (r) =>
        !r.archived &&
        r.projectId === lineage.project.id &&
        String(r.title).trim().toLowerCase() === employee.toLowerCase() &&
        ["side", "manager"].includes(String(r.kind)),
    )
  )
    throw Error("duplicate_employee_name");
  const model = request.model?.trim() || text(template.model);
  const folders = (request.folders ?? []).map((f) => f.trim()).filter(Boolean);
  const reasons: string[] = [];
  if (actor) {
    const caller = state.agent?.find((r) => r.id === actor.agentId);
    if (level(template.permissionProfile) > level(caller?.permissionProfile))
      reasons.push("permission_widening");
  }
  if (level(template.permissionProfile) > level("workspace_write")) reasons.push("wide_permission");
  const allowance = actor ? readStaffAllowance(state, actor.threadId) : undefined;
  const covered =
    actor && !reasons.length && allowanceCovers(allowance, lineage.project.id, model, folders);
  if (actor && !covered) reasons.unshift("new_employee");
  const where = teamName(state, node);
  return {
    reasons,
    ...(covered && allowance ? { allowance } : {}),
    resolved: {
      node,
      projectId: lineage.project.id,
      template,
      model,
      folders,
      name: employee,
      role,
      extra,
      ...(starter ? { templateId: starter.id } : {}),
    },
    preview: {
      kind: "add",
      projectId: lineage.project.id,
      name: employee,
      teamName: where,
      ...(requester
        ? { requestedBy: { threadId: String(requester.id), name: String(requester.title) } }
        : {}),
      fields: [
        ...(starter ? [field("From template", undefined, starter.name)] : []),
        field("Name", undefined, employee),
        ...(role ? [field("Role", undefined, role)] : []),
        field("Model", undefined, model || "Provider default"),
        field("Can edit", undefined, folders.length ? folders.join(", ") : "Any folder"),
        field("Reports to", undefined, String(manager?.title ?? where)),
        ...(request.firstTask ? [field("First task", undefined, request.firstTask.title)] : []),
      ],
      ...(actor && !reasons.includes("permission_widening") && !reasons.includes("wide_permission")
        ? { allowanceOffer: { max: STAFF_DEFAULT_OFFER, models: model ? [model] : [], folders } }
        : {}),
    },
  };
}

function planChange(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  request: Extract<StaffRequest, { kind: "change" }>,
): StaffPlan {
  const thread = staffMember(state, request.threadId);
  if (actor?.threadId === thread.id) throw Error("cannot_change_self");
  requireScope(state, actor, nodeOf(thread));
  const profile = state.agent?.find((r) => r.id === thread.agentId && !r.archived);
  if (!profile) throw Error("profile_unavailable");
  const fields: StaffField[] = [];
  const changes: Row = {};
  if (request.name !== undefined && name(request.name) !== String(thread.title)) {
    changes.name = name(request.name);
    fields.push(field("Name", String(thread.title), String(changes.name)));
  }
  if (request.role !== undefined && request.role.trim() !== text(profile.roleText)) {
    changes.roleText = request.role.trim();
    fields.push(field("Role", text(profile.roleText), request.role.trim()));
  }
  if (request.model !== undefined && request.model.trim() !== text(profile.model)) {
    changes.model = request.model.trim();
    fields.push(field("Model", text(profile.model) || "Provider default", request.model.trim()));
  }
  if (request.instructions !== undefined && request.instructions !== text(profile.instructions)) {
    changes.instructions = request.instructions;
    fields.push(field("Instructions", text(profile.instructions), request.instructions));
  }
  if (!fields.length) throw Error("no_staff_change");
  const sharedWith = (state.thread ?? []).filter(
    (r) => !r.archived && r.agentId === thread.agentId && r.id !== thread.id && r.kind !== "task",
  ).length;
  return {
    reasons: actor ? ["profile_change"] : [],
    resolved: { thread, profile, changes, sharedWith },
    preview: {
      kind: "change",
      projectId: String(thread.projectId),
      name: String(thread.title),
      threadId: String(thread.id),
      teamName: teamName(state, nodeOf(thread)),
      ...(actor
        ? {
            requestedBy: {
              threadId: actor.threadId,
              name: String(live(state, actor.threadId)?.title ?? ""),
            },
          }
        : {}),
      fields,
      ...(sharedWith ? { sharedWith } : {}),
    },
  };
}

/** Whether a profile belongs to this employee alone, so its task chats count as its work. */
function dedicated(state: DomainState, thread: Row) {
  return !(state.thread ?? []).some(
    (r) => !r.archived && r.agentId === thread.agentId && r.id !== thread.id && r.kind !== "task",
  );
}
/** The employee's tasks: assignments in its chat, and with its own profile, its task chats. */
export function employeeTasks(state: DomainState, thread: Row): Row[] {
  const own = dedicated(state, thread);
  return (state.task ?? []).filter(
    (r) =>
      r.threadId === thread.id ||
      (own &&
        r.ownerAgentId === thread.agentId &&
        r.projectId === thread.projectId &&
        state.thread?.some((t) => t.id === r.threadId && t.kind === "task")),
  );
}

function planArchive(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  request: Extract<StaffRequest, { kind: "archive" }>,
): StaffPlan {
  const thread = staffMember(state, request.threadId);
  if (actor?.threadId === thread.id) throw Error("cannot_archive_self");
  requireScope(state, actor, nodeOf(thread));
  if (
    state.initiativeRecord?.some(
      (r) =>
        r.managerThreadId === thread.id && !["completed", "cancelled"].includes(String(r.state)),
    )
  )
    throw Error("employee_owns_initiative: move its initiatives first");
  const tasks = employeeTasks(state, thread);
  const queued = tasks.filter((r) => r.state === "queued");
  const running = tasks.filter((r) => r.state === "running" || r.state === "blocked").length;
  const turning = state.turn?.some((r) => r.threadId === thread.id && r.status === "running");
  const accountable = (state.task ?? []).filter(
    (r) => r.accountableThreadId === thread.id && ACTIVE.includes(String(r.state)),
  );
  const fallback =
    managerAbove(state, String(thread.id))?.id ??
    (actor && actor.threadId !== thread.id ? actor.threadId : undefined);
  const destinationId =
    request.moveTo ?? (queued.length || accountable.length ? fallback : undefined);
  let destination: Row | undefined;
  if (destinationId) {
    destination = live(state, destinationId);
    if (
      !destination ||
      destination.id === thread.id ||
      destination.projectId !== thread.projectId ||
      !["side", "manager"].includes(String(destination.kind))
    )
      throw Error("move_target_unavailable");
    if (actor && destination.id !== actor.threadId) requireScope(state, actor, nodeOf(destination));
  } else if (queued.length || accountable.length) throw Error("move_target_required");
  const to = String(destination?.title ?? "");
  return {
    reasons: actor ? ["archive_employee"] : [],
    resolved: { thread, queued, accountable, destination, working: running > 0 || turning },
    preview: {
      kind: "archive",
      projectId: String(thread.projectId),
      name: String(thread.title),
      threadId: String(thread.id),
      teamName: teamName(state, nodeOf(thread)),
      ...(actor
        ? {
            requestedBy: {
              threadId: actor.threadId,
              name: String(live(state, actor.threadId)?.title ?? ""),
            },
          }
        : {}),
      fields: destination ? [field("Queued tasks go to", undefined, to)] : [],
      moves: queued.map((r) => ({ taskId: String(r.id), title: String(r.title), to })),
      running: running + (turning ? 1 : 0),
    },
  };
}

/** What a request would do and the reasons the owner must approve it. Empty reasons run directly. */
export function planStaffChange(
  state: DomainState,
  actor: WorkspaceActor | undefined,
  input: StaffRequest,
): StaffPlan {
  const request = parse(StaffRequestSchema, input);
  if (request.kind === "add") return planAdd(state, actor, request);
  if (request.kind === "change") return planChange(state, actor, request);
  return planArchive(state, actor, request);
}
