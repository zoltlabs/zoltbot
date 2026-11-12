import type { CellTokenClaims } from "@zoltbot/cloud-contracts";
import {
  answerInteractions,
  type CommandContext,
  cancelTask,
  createScopedChat,
  createTask,
  type DomainState,
  deferInteraction,
  handle,
  type Outcome,
  retryTask,
} from "@zoltbot/core";
import {
  type EntityKind,
  methodCatalog,
  ProjectSchema,
  parse,
  parseRequest,
  TaskSchema,
} from "@zoltbot/protocol";
import type { ReadScope, Snapshot, Store } from "@zoltbot/store/portable";
import type { CellService } from "./service.js";

const metadata: readonly EntityKind[] = [
  "project",
  "thread",
  "task",
  "agent",
  "agentDefinition",
  "workspace",
  "session",
  "turn",
  "interaction",
  "taskResult",
  "rule",
  "audit",
];
const publicErrors = new Set([
  "confirmation_required",
  "command_id_required",
  "command_conflict",
  "scope_unavailable",
  "profile_unavailable",
  "stale_revision",
  "interaction_conflict",
  "interaction_not_pending",
  "limit_reached",
  "store_rebuilding",
  "method_unavailable",
  "forbidden",
  "storage_full",
  "runner_sequence_gap",
  "runner_session_required",
  "runtime_native_identity_changed",
  "task_not_running",
]);
export function safeError(error: unknown): string {
  const code = error instanceof Error ? error.message.split(":")[0] : undefined;
  return code && publicErrors.has(code) ? code : "request_failed";
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
/** The personal org has one member. All IDs below resolve inside this object's database. */
export class CloudRpc {
  private fingerprint = "";
  constructor(
    private readonly store: Store,
    private readonly claims: CellTokenClaims,
    private readonly service: CellService,
  ) {}
  private project(id: unknown) {
    const row = typeof id === "string" ? this.store.record("project", id) : undefined;
    if (!row?.cloud || row.archived) throw new Error("forbidden");
    return parse(ProjectSchema, row);
  }
  private owner(kind: EntityKind, id: unknown): { row: Record<string, unknown>; scope: ReadScope } {
    const row = typeof id === "string" ? this.store.record(kind, id) : undefined;
    if (!row) throw new Error("forbidden");
    const taskId = kind === "task" ? row.id : row.taskId;
    const thread = row.threadId ? this.store.record("thread", String(row.threadId)) : undefined;
    const projectId = row.projectId ?? thread?.projectId;
    this.project(projectId);
    return {
      row,
      scope: typeof taskId === "string" ? { taskId } : { projectId: String(projectId) },
    };
  }
  private projects(cursor = "", limit = 200) {
    return this.store.database
      .prepare("SELECT id FROM projects WHERE id>? ORDER BY id LIMIT ?")
      .all(cursor, limit + 1)
      .map(
        (row) =>
          this.store.read({ projectId: String((row as { id: string }).id) }, ["project"])
            .project?.[0],
      )
      .filter((row): row is Record<string, unknown> => !!row?.cloud && !row.archived);
  }
  private page(kind: EntityKind, params: Record<string, unknown>) {
    const projects = params.projectId ? [this.project(params.projectId)] : this.projects();
    const records = projects.flatMap(
      (project) => this.store.read({ projectId: String(project.id) }, [kind])[kind] ?? [],
    );
    const unique = [
      ...new Map(records.map((row) => [String((row as { id: string }).id), row])).values(),
    ]
      .filter(
        (row) =>
          (!params.agentId || row.agentId === params.agentId) &&
          !row.archived &&
          (!params.state || params.state === "all" || row.state === params.state) &&
          String((row as { id: string }).id) > String(params.cursor ?? ""),
      )
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const limit = Number(params.limit ?? 200);
    const items = unique.slice(0, limit);
    return { items, ...(unique.length > limit ? { cursor: String(items.at(-1)?.id) } : {}) };
  }
  private mutate(
    request: ReturnType<typeof parseRequest>,
    scope: ReadScope,
    produce: (state: Snapshot, context: CommandContext) => Outcome,
  ) {
    if (!request.commandId) throw new Error("command_id_required");
    const commandId = `client:${request.commandId}`;
    const context: CommandContext = {
      commandId,
      at: new Date().toISOString(),
      actor: { kind: "human", id: this.claims.sub },
    };
    const fingerprint = this.fingerprint;
    const previous = this.store.receipt<{ fingerprint: string; value: Record<string, unknown> }>(
      commandId,
    );
    if (previous) {
      if (previous.result.fingerprint !== fingerprint) throw new Error("command_conflict");
      return previous.result.value;
    }
    return this.store.dispatch(
      commandId,
      (state) => {
        const output = produce(state, context);
        parse(methodCatalog[request.method].result, output.result);
        return {
          events: output.events,
          result: { fingerprint, value: output.result, actor: request.actor },
        };
      },
      { scope, kinds: metadata },
    ).result.value;
  }
  async call(input: unknown) {
    if (this.claims.kind !== "client") throw new Error("forbidden");
    let request = parseRequest(input, {
      userId: this.claims.sub,
      deviceId: this.claims.device,
      surface: this.claims.surface,
    });
    if (methodCatalog[request.method].where === "local") throw new Error("forbidden");
    if (request.commandId) {
      const bytes = new TextEncoder().encode(
        JSON.stringify([this.claims.org, this.claims.sub, this.claims.device, request.commandId]),
      );
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
      request = { ...request, commandId: hash };
    }
    this.fingerprint = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify([request.method, canonical(request.params)])),
        ),
      ),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const p = request.params as Record<string, unknown>;
    let result: unknown;
    switch (request.method) {
      case "hello":
        result = { protocolVersion: 1, version: "0.1.0" };
        break;
      case "cloud.project.create": {
        const value = parse(methodCatalog["cloud.project.create"].params, p);
        const id = `project:${request.commandId ?? ""}`;
        result = this.mutate(request, { projectId: id }, (state, context) =>
          handle(
            state,
            {
              type: "create",
              kind: "project",
              value: {
                id,
                name: value.name,
                goal: "",
                instructions: "",
                constraints: "",
                roots: [],
                hierarchyDepth: 0,
                tags: [],
                requireCodeReview: false,
                skipFinalGateWhenReviewed: false,
                archived: false,
                createdAt: context.at,
                cloud: {
                  repository: value.repository,
                  defaultBranch: value.defaultBranch,
                  setupScript: value.setupScript,
                },
              },
            },
            context,
          ),
        );
        break;
      }
      case "cloud.project.list":
      case "project.list": {
        const rows = this.projects(String(p.cursor ?? ""), Number(p.limit ?? 200));
        const limit = Number(p.limit ?? 200);
        result = {
          items: rows.slice(0, limit),
          ...(rows.length > limit ? { cursor: rows[limit - 1]?.id } : {}),
        };
        break;
      }
      case "agent.list":
      case "agentDefinition.list": {
        const kind = request.method === "agent.list" ? "agent" : "agentDefinition";
        const ids = kind === "agent" ? ["cloud-claude", "cloud-codex"] : ["claude", "codex"];
        result = { items: ids.map((id) => this.store.record(kind, id)).filter(Boolean) };
        break;
      }
      case "snapshot.get": {
        const entities: Snapshot = {};
        for (const project of this.projects()) {
          const scoped = this.store.read({ projectId: String(project.id) }, metadata);
          for (const [kind, rows] of Object.entries(scoped))
            entities[kind] = [...(entities[kind] ?? []), ...rows];
        }
        entities.agent = ["cloud-claude", "cloud-codex"].flatMap((id) => {
          const row = this.store.record("agent", id);
          return row ? [row] : [];
        });
        result = { seq: this.store.lastSeq(), entities, counters: {} };
        break;
      }
      case "events.subscribe": {
        const seq = this.store.lastSeq();
        const from = p.fromSeq;
        const resync = typeof from !== "number" || from > seq || seq - from > 1000;
        result = { seq, resync, events: resync ? [] : this.store.eventsSince(from as number, 1) };
        break;
      }
      case "events.unsubscribe":
        result = { ok: true };
        break;
      case "task.list":
        result = this.page("task", p);
        break;
      case "thread.list":
        result = this.page("thread", p);
        break;
      case "interaction.list":
        result = this.page("interaction", p);
        break;
      case "audit.list":
        result = this.page("audit", p);
        break;
      case "rule.list":
        result = this.page("rule", p);
        break;
      case "interaction.answer": {
        const value = parse(methodCatalog["interaction.answer"].params, p);
        const owned = this.owner("interaction", value.id);
        result = this.mutate(request, owned.scope, (state, context) =>
          handle(
            state,
            {
              type: "answer",
              id: value.id,
              version: value.version,
              answer: {
                ...value.answer,
                by: context.actor,
                device: this.claims.device,
                at: context.at,
              },
            },
            context,
          ),
        );
        break;
      }
      case "interaction.defer": {
        const owned = this.owner("interaction", p.id);
        const output = this.mutate(request, owned.scope, (state, context) => {
          const outcome = deferInteraction(state, String(p.id), context);
          return { ...outcome, result: { ok: true } };
        });
        result = output;
        break;
      }
      case "interaction.batchAnswer": {
        const value = parse(methodCatalog["interaction.batchAnswer"].params, p);
        const owned = value.items.map((item) => this.owner("interaction", item.id));
        const projectIds = owned
          .map((entry) => entry.row.threadId)
          .map((id) => String(this.store.record("thread", String(id))?.projectId));
        result = this.mutate(request, { projectId: projectIds[0] as string }, (_state, context) => {
          const state: Snapshot = {};
          for (const projectId of new Set(projectIds)) {
            const scoped = this.store.read({ projectId }, metadata);
            for (const [kind, rows] of Object.entries(scoped))
              state[kind] = [
                ...new Map(
                  [...(state[kind] ?? []), ...rows].map((row) => [String(row.id ?? row.key), row]),
                ).values(),
              ];
          }
          return answerInteractions(
            state,
            value.items.map((item) => ({
              ...item,
              answer: {
                ...item.answer,
                by: context.actor,
                device: this.claims.device,
                at: context.at,
              },
            })),
            context,
          );
        });
        break;
      }
      case "task.create": {
        const value = parse(methodCatalog["task.create"].params, p);
        if (value.node.type !== "project" || !value.location) throw new Error("scope_unavailable");
        this.project(value.node.id);
        const profile = this.store.record("agent", value.profileId);
        if (!profile || !["claude", "codex"].includes(String(profile.definitionId)))
          throw new Error("profile_unavailable");
        result = this.mutate(request, { projectId: value.node.id }, (state, context) => {
          const withProfile: DomainState = { ...state, agent: [profile] };
          const output = createTask(
            withProfile,
            {
              id: `task:${request.commandId}`,
              title: value.title,
              brief: value.brief,
              profileId: value.profileId,
              node: value.node,
              ...(value.acceptance !== undefined ? { acceptance: value.acceptance } : {}),
              ...(value.baseRef !== undefined ? { baseRef: value.baseRef } : {}),
              workspaceMode: "worktree",
            },
            context,
          );
          output.events = output.events.map((event) =>
            event.aggregateType === "task"
              ? {
                  ...event,
                  payload: {
                    ...(event.payload as object),
                    location: value.location,
                    executionLocation: value.location,
                  },
                }
              : event,
          );
          return {
            ...output,
            result: {
              ...output.result,
              location: value.location,
              executionLocation: value.location,
            },
          };
        });
        break;
      }
      case "task.cancel": {
        const value = parse(methodCatalog["task.cancel"].params, p);
        const owned = this.owner("task", value.id);
        result = this.mutate(request, owned.scope, (state, context) =>
          cancelTask(state, value.id, value.confirmed, context),
        );
        break;
      }
      case "task.retry": {
        const value = parse(methodCatalog["task.retry"].params, p);
        const owned = this.owner("task", value.id);
        const task = parse(TaskSchema, owned.row);
        result = this.mutate(request, owned.scope, (state, context) =>
          retryTask(state, value.id, task.revision, context),
        );
        break;
      }
      case "task.review": {
        const value = parse(methodCatalog["task.review"].params, p);
        if (!value.confirmed) throw new Error("confirmation_required");
        const owned = this.owner("task", value.id);
        result = this.mutate(request, owned.scope, (state, context) =>
          handle(
            state,
            {
              type: "review",
              id: value.id,
              revision: value.revision,
              decision: value.decision,
              ...(value.feedback ? { feedback: value.feedback } : {}),
            },
            context,
          ),
        );
        break;
      }
      case "task.update": {
        const value = parse(methodCatalog["task.update"].params, p);
        const owned = this.owner("task", value.id);
        // A client cannot transfer ownership or replace a running task's execution target.
        if (
          ["projectId", "ownerAgentId", "location", "executionLocation", "workspaceId"].some(
            (key) =>
              key in value.changes &&
              value.changes[key as keyof typeof value.changes] !== owned.row[key],
          )
        )
          throw new Error("forbidden");
        result = this.mutate(request, owned.scope, (state, context) =>
          handle(
            state,
            { type: "update", kind: "task", id: value.id, changes: value.changes },
            context,
          ),
        );
        break;
      }
      case "thread.create": {
        const value = parse(methodCatalog["thread.create"].params, p);
        this.project(value.value.projectId);
        result = this.mutate(
          request,
          { projectId: String(value.value.projectId) },
          (state, context) => createScopedChat(state, value.value, context, value.confirmed),
        );
        break;
      }
      case "thread.rename":
      case "thread.archive": {
        const owned = this.owner("thread", p.id);
        result = this.mutate(request, owned.scope, (state, context) =>
          handle(
            state,
            {
              type: "update",
              kind: "thread",
              id: String(p.id),
              changes:
                request.method === "thread.rename"
                  ? { title: p.title, titleSource: "human" }
                  : { archived: true },
            },
            context,
          ),
        );
        break;
      }
      case "thread.history": {
        const value = parse(methodCatalog["thread.history"].params, p);
        this.owner("thread", value.threadId);
        const limit = value.limit ?? 100;
        const rows = this.store.database
          .prepare("SELECT id FROM items WHERE thread_id=? AND seq>? ORDER BY seq LIMIT ?")
          .all(value.threadId, Number(value.cursor ?? 0), limit + 1);
        const items = rows
          .slice(0, limit)
          .map((row) => this.store.record("item", String((row as { id: string }).id)));
        result = { items, ...(rows.length > limit ? { cursor: String(items.at(-1)?.seq) } : {}) };
        break;
      }
      case "usage.get":
        result = await this.service.request("usage", "POST", { orgId: this.claims.org });
        break;
      default:
        throw new Error("method_unavailable");
    }
    parse(methodCatalog[request.method].result, result);
    return { jsonrpc: "2.0", id: request.id, result };
  }
}
