import {
  type CompanyChange,
  type DomainEvent,
  type EntityKind,
  entitySchemas,
  parse,
  parseEvent,
  type Scope,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { saveInitiative, saveRemit } from "./company.js";
import { createDirection, createScopedChat, scopeLineage } from "./hierarchy.js";
import { applyEvents, type DomainState } from "./projectors.js";
import { createTask } from "./tasks.js";
import { scopeContains } from "./team.js";

/** Full canonical comparison, rather than a lossy hash. Excludes conversational activity. */
export function companyBaseline(state: DomainState, projectId: string): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  const rows = Object.fromEntries(
    ["project", "subproject", "initiativeRecord", "managerRemit", "task"].map((kind) => [
      kind,
      (state[kind] ?? [])
        .filter((r) => (kind === "project" ? r.id === projectId : r.projectId === projectId))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ]),
  );
  return JSON.stringify(
    canonical({
      ...rows,
      thread: (state.thread ?? [])
        .filter((r) => r.projectId === projectId)
        .map((r) => ({
          id: r.id,
          agentId: r.agentId,
          node: r.node,
          kind: r.kind,
          archived: r.archived,
          title: r.title,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      profiles: (state.agent ?? [])
        .map((r) => ({
          id: r.id,
          permissionProfile: r.permissionProfile,
          archived: r.archived,
          model: r.model,
          instructions: r.instructions,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    }),
  );
}
/** Dedicated, schema-validated replacement for fields protected from generic CRUD. */
export function companyRecord(
  kind: EntityKind,
  value: Record<string, unknown>,
  context: CommandContext,
): Outcome {
  parse(entitySchemas[kind], value);
  return {
    events: [
      parseEvent({
        eventId: `${context.commandId}:0`,
        commandId: context.commandId,
        aggregateType: kind,
        aggregateId: String(value.id),
        type: `${kind}.updated`,
        occurredAt: context.at,
        payload: value,
      }),
    ],
    result: value,
  };
}
export function applyCompanyChanges(
  initial: DomainState,
  projectId: string,
  changes: CompanyChange[],
  context: CommandContext,
) {
  if (context.actor.kind !== "human") throw Error("human_approval_required");
  let state = initial;
  const events: DomainEvent[] = [],
    preview: { change: CompanyChange; before: unknown; after: unknown }[] = [];
  const add = (out: Outcome) => {
    events.push(...out.events);
    state = applyEvents(state, out.events);
  };
  const row = (kind: string, id: string) => {
    const found = state[kind]?.find((r) => r.id === id && !r.archived);
    if (!found || found.projectId !== projectId) throw Error("cross_workspace_change_forbidden");
    return found;
  };
  const parent = (scope: Scope) => {
    const lineage = scopeLineage(state, scope);
    if (lineage.project.id !== projectId) throw Error("cross_workspace_change_forbidden");
    return lineage;
  };
  for (const [i, change] of changes.entries()) {
    if (!change.why.trim()) throw Error("change_reason_required");
    const ctx = { ...context, commandId: `${context.commandId}:change:${i}` };
    let before: unknown = null;
    const start = events.length;
    if (change.kind === "assignManager") {
      const chat = row("thread", change.id);
      before = chat;
      parent(change.parent);
      const old = state.thread?.find(
        (r) =>
          r.kind === "manager" &&
          !r.archived &&
          JSON.stringify(r.node) === JSON.stringify(change.parent),
      );
      const targets = new Set([chat.id, old?.id]);
      if (
        (state.turn ?? []).some((r) => targets.has(r.threadId) && r.status === "running") ||
        (state.task ?? []).some(
          (r) =>
            targets.has(r.threadId) && ["queued", "running", "blocked"].includes(String(r.state)),
        )
      )
        throw Error("manager_busy: replace at a safe boundary");
      if (chat.kind === "task") throw Error("task_cannot_be_manager");
      if (old && old.id !== chat.id) add(companyRecord("thread", { ...old, kind: "side" }, ctx));
      add(companyRecord("thread", { ...chat, kind: "manager", node: change.parent }, ctx));
    } else if (change.kind === "moveTask") {
      const task = row("task", change.id);
      before = task;
      if (
        change.initiativeId &&
        !state.initiativeRecord?.some(
          (r) =>
            r.id === change.initiativeId &&
            r.projectId === projectId &&
            !["completed", "cancelled"].includes(String(r.state)),
        )
      )
        throw Error("initiative_unavailable");
      if (change.accountableThreadId) row("thread", change.accountableThreadId);
      if (["running", "blocked"].includes(String(task.state)))
        throw Error(
          "task_busy: change initiative at a safe boundary; use assignTask for deferred accountability",
        );
      const value: Record<string, unknown> = { ...task, updatedAt: context.at };
      delete value.initiativeId;
      if (change.initiativeId) value.initiativeId = change.initiativeId;
      if (change.accountableThreadId) {
        value.accountableThreadId = change.accountableThreadId;
        value.assignmentHistory = [
          ...((task.assignmentHistory as unknown[]) ?? []),
          { threadId: change.accountableThreadId, at: context.at },
        ];
      }
      add(companyRecord("task", value, ctx));
    } else if (change.kind === "team") {
      const lineage = parent(change.parent);
      add(
        createDirection(
          state,
          {
            id: change.id,
            projectId,
            ...(change.parent.type === "subproject" ? { parentId: change.parent.id } : {}),
            name: change.name,
            label: "Team",
            goal: "",
            instructions: "",
            depth: lineage.directions.length + 1,
            archived: false,
            createdAt: context.at,
          },
          ctx,
        ),
      );
    } else if (change.kind === "chat") {
      parent(change.parent);
      add(
        createScopedChat(
          state,
          {
            id: change.id,
            agentId: change.profileId,
            projectId,
            node: change.parent,
            kind: change.manager ? "manager" : "side",
            title: change.title,
            titleSource: "human",
            pinned: false,
            archived: false,
            createdAt: context.at,
            lastActivityAt: context.at,
          },
          ctx,
          true,
        ),
      );
    } else if (change.kind === "initiative" || change.kind === "remit") {
      if (change.value.projectId !== projectId) throw Error("cross_workspace_change_forbidden");
      before =
        state[change.kind === "initiative" ? "initiativeRecord" : "managerRemit"]?.find(
          (r) => r.id === change.value.id,
        ) ?? null;
      add(
        change.kind === "initiative"
          ? saveInitiative(state, change.value, ctx)
          : saveRemit(state, change.value, ctx),
      );
    } else if (change.kind === "task") {
      parent(change.value.node);
      add(createTask(state, change.value, ctx));
    } else if (change.kind === "renameTeam") {
      before = row("subproject", change.id);
      if (!change.name.trim() || change.name.length > 150) throw Error("invalid_scope_name");
      add(
        handle(
          state,
          { type: "update", kind: "subproject", id: change.id, changes: { name: change.name } },
          ctx,
        ),
      );
    } else if (change.kind === "archiveTeam") {
      before = row("subproject", change.id);
      if (
        (state.subproject ?? []).some((r) => r.parentId === change.id && !r.archived) ||
        (state.thread ?? []).some(
          (r) => !r.archived && (r.node as Scope | undefined)?.id === change.id,
        ) ||
        (state.initiativeRecord ?? []).some(
          (r) => r.teamId === change.id && !["completed", "cancelled"].includes(String(r.state)),
        )
      )
        throw Error("team_not_empty: move its work and chats first");
      add(
        handle(
          state,
          {
            type: "update",
            kind: "subproject",
            id: change.id,
            changes: { archived: true },
            confirmed: true,
          },
          ctx,
        ),
      );
    } else if (change.kind === "moveTeam") {
      const team = row("subproject", change.id);
      before = team;
      const lineage = parent(change.parent);
      if (scopeContains(state, { type: "subproject", id: change.id }, change.parent))
        throw Error("team_cycle");
      const descendants = (state.subproject ?? []).filter(
        (r) =>
          !r.archived &&
          scopeContains(
            state,
            { type: "subproject", id: change.id },
            { type: "subproject", id: String(r.id) },
          ),
      );
      const affected = new Set(
        (state.thread ?? [])
          .filter(
            (r) => r.node && scopeContains(state, { type: "subproject", id: change.id }, r.node),
          )
          .map((r) => r.id),
      );
      if (
        (state.turn ?? []).some((r) => affected.has(r.threadId) && r.status === "running") ||
        (state.task ?? []).some(
          (r) =>
            affected.has(r.threadId) && ["queued", "running", "blocked"].includes(String(r.state)),
        )
      )
        throw Error("team_busy: move at a safe boundary");
      const delta = lineage.directions.length + 1 - Number(team.depth);
      if (descendants.some((r) => Number(r.depth) + delta > 3)) throw Error("hierarchy_too_deep");
      for (const item of descendants) {
        const value: Record<string, unknown> = { ...item, depth: Number(item.depth) + delta };
        if (item.id === team.id) {
          delete value.parentId;
          if (change.parent.type === "subproject") value.parentId = change.parent.id;
        }
        add(companyRecord("subproject", value, ctx));
      }
      const depth = Math.max(
        ...(state.subproject ?? [])
          .filter((r) => r.projectId === projectId && !r.archived)
          .map((r) => Number(r.depth)),
        0,
      );
      add(
        handle(
          state,
          { type: "update", kind: "project", id: projectId, changes: { hierarchyDepth: depth } },
          ctx,
        ),
      );
    } else if (change.kind === "moveChat") {
      const chat = row("thread", change.id);
      before = chat;
      parent(change.parent);
      if (
        (state.turn ?? []).some((r) => r.threadId === chat.id && r.status === "running") ||
        (state.item ?? []).some(
          (r) =>
            r.threadId === chat.id && (r.body as { queueState?: string })?.queueState === "queued",
        )
      )
        throw Error("chat_busy: move at a safe boundary");
      if (chat.kind === "task") throw Error("task_context_move_forbidden");
      if (
        chat.kind === "manager" &&
        state.thread?.some(
          (r) =>
            r.id !== chat.id &&
            r.kind === "manager" &&
            !r.archived &&
            JSON.stringify(r.node) === JSON.stringify(change.parent),
        )
      )
        throw Error("manager_already_assigned");
      add(companyRecord("thread", { ...chat, node: change.parent }, ctx));
    } else if (change.kind === "assignTask") {
      const task = row("task", change.id);
      before = task;
      if (
        !state.settings?.some(
          (r) => r.key === "chief.thread" && r.value === change.accountableThreadId,
        )
      )
        row("thread", change.accountableThreadId);
      const running = ["running", "blocked"].includes(String(task.state));
      add(
        companyRecord(
          "task",
          running
            ? {
                ...task,
                pendingAccountableThreadId: change.accountableThreadId,
                updatedAt: context.at,
              }
            : {
                ...task,
                accountableThreadId: change.accountableThreadId,
                assignmentHistory: [
                  ...((task.assignmentHistory as unknown[]) ?? []),
                  { threadId: change.accountableThreadId, at: context.at },
                ],
                updatedAt: context.at,
              },
          ctx,
        ),
      );
    } else if (change.kind === "releaseTask") {
      const task = row("task", change.id);
      before = task;
      if (task.state !== "queued") throw Error("task_not_queued");
      add(companyRecord("task", { ...task, planned: false, updatedAt: context.at }, ctx));
    }
    preview.push({
      change,
      before,
      after: events.slice(start).map((e) => ({ kind: e.aggregateType, value: e.payload })),
    });
  }
  // Every event persists together inside one store dispatch, including history and notifications.
  add(
    handle(
      state,
      {
        type: "create",
        kind: "audit",
        value: {
          id: `${context.commandId}:company`,
          actor: context.actor,
          action: "company.apply",
          target: projectId,
          result: "allowed",
          detail: { changes },
          at: context.at,
        },
      },
      context,
    ),
  );
  return { state, events, preview };
}
