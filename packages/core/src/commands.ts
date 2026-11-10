import {
  type ActorRef,
  assertNoPrivateValue,
  type DomainEvent,
  type EntityKind,
  entitySchemas,
  type InteractionAnswer,
  type PermissionProfile,
  parse,
  parseEvent,
  privateAnswerValues,
  publicAnswerData,
} from "@zoltbot/protocol";
import { validateInteractionAnswer } from "./interaction-answers.js";
import { type DomainState, entityId } from "./projectors.js";
import { requireChildrenAccepted } from "./task-graph.js";
import { type Machine, transition } from "./transitions.js";

export interface CommandContext {
  commandId: string;
  at: string;
  actor: ActorRef;
}
interface Confirmed {
  confirmed?: boolean;
}
export type Command =
  | ({ type: "create"; kind: EntityKind; value: Record<string, unknown> } & Confirmed)
  | ({ type: "update"; kind: EntityKind; id: string; changes: Record<string, unknown> } & Confirmed)
  | ({
      type: "transition";
      kind: Machine;
      id: string;
      to: string;
      revision?: number;
      reason?: string;
    } & Confirmed)
  | { type: "answer"; id: string; version: number; answer: InteractionAnswer }
  | {
      type: "review";
      id: string;
      revision: number;
      decision: "accept" | "changes" | "reject";
      feedback?: string;
    }
  | {
      type: "submitResult";
      id: string;
      revision: number;
      status: "done" | "partial" | "blocked" | "failed";
      summary: string;
      files: string[];
    };
export interface Outcome {
  events: DomainEvent[];
  result: Record<string, unknown>;
}
const permissionOrder: PermissionProfile[] = [
  "read_only",
  "workspace_write",
  "workspace_write_net",
  "full_access",
];
function requireConfirmation(confirmed: boolean | undefined, context: CommandContext) {
  if (!confirmed || context.actor.kind !== "human")
    throw new Error("confirmation_required: explicit human confirmation needed");
}
function find(state: DomainState, kind: string, id: string): Record<string, unknown> {
  const entity = state[kind]?.find((e) => entityId(kind, e) === id);
  if (!entity) throw new Error(`not_found: ${kind} ${id}`);
  return entity;
}
function fence(task: Record<string, unknown>, revision: number | undefined) {
  if (task.revision !== revision) throw new Error("stale_revision: task revision changed");
}
function event(
  kind: EntityKind,
  entity: Record<string, unknown>,
  context: CommandContext,
  verb = "updated",
  index = 0,
): DomainEvent {
  parse(entitySchemas[kind], entity);
  return parseEvent({
    eventId: `${context.commandId}:${index}`,
    commandId: context.commandId,
    aggregateType: kind,
    aggregateId: entityId(kind, entity),
    type: `${kind}.${verb}`,
    occurredAt: context.at,
    payload: entity,
  });
}
function change(
  kind: EntityKind,
  entity: Record<string, unknown>,
  context: CommandContext,
): Outcome {
  return { events: [event(kind, entity, context)], result: entity };
}
function validatePermissions(
  kind: EntityKind,
  old: Record<string, unknown> | undefined,
  value: Record<string, unknown>,
  confirmed: boolean | undefined,
  context: CommandContext,
) {
  if (kind === "grant" || kind === "rule") requireConfirmation(confirmed, context);
  if (kind === "agent" && value.permissionProfile) {
    const oldLevel = permissionOrder.indexOf(
      (old?.permissionProfile ?? "workspace_write") as PermissionProfile,
    );
    const nextLevel = permissionOrder.indexOf(value.permissionProfile as PermissionProfile);
    if (nextLevel > oldLevel) requireConfirmation(confirmed, context);
  }
}
function execute(state: DomainState, command: Command, context: CommandContext): Outcome {
  if (command.type === "create") {
    const { kind, value } = command;
    const id = entityId(kind, value);
    if (!id) throw new Error("invalid_id");
    if (state[kind]?.some((e) => entityId(kind, e) === id))
      throw new Error(`already_exists: ${kind} ${id}`);
    validatePermissions(kind, undefined, value, command.confirmed, context);
    const initial: Partial<Record<EntityKind, string>> = {
      task: "queued",
      interaction: "pending",
      session: "starting",
      turn: "running",
      delivery: "queued",
      workspace: "active",
    };
    if (initial[kind] && value.state !== undefined && value.state !== initial[kind])
      throw new Error("invalid_initial_state");
    if (kind === "turn" && value.status !== "running") throw new Error("invalid_initial_state");
    if (kind === "task" && (value.revision !== 1 || value.attempt !== 1))
      throw new Error("invalid_initial_revision");
    if (kind === "interaction" && value.version !== 1) throw new Error("invalid_initial_version");
    if (
      kind === "session" &&
      (state.session ?? []).some(
        (s) =>
          s.threadId === value.threadId &&
          ["starting", "ready", "running"].includes(String(s.state)),
      )
    )
      throw new Error("session_owned: one writer per thread");
    if (kind === "subproject" && value.parentId) {
      const parent = find(state, kind, String(value.parentId));
      if (parent.projectId !== value.projectId || Number(parent.depth) + 1 !== value.depth)
        throw new Error("invalid_hierarchy");
    }
    return { events: [event(kind, value, context, "created")], result: value };
  }
  if (command.type === "update") {
    const current = find(state, command.kind, command.id);
    const protectedFields = [
      "id",
      "state",
      "status",
      "revision",
      "version",
      "resolution",
      "nativeId",
      "browser",
      "cwd",
      "threadId",
      "rootId",
      "parentId",
      "attempt",
      "createdAt",
    ];
    if (Object.keys(command.changes).some((k) => protectedFields.includes(k)))
      throw new Error("protected_field: use the dedicated command");
    validatePermissions(command.kind, current, command.changes, command.confirmed, context);
    const next = { ...current, ...command.changes };
    if ("updatedAt" in next) next.updatedAt = context.at;
    return change(command.kind, next, context);
  }
  if (command.type === "transition") {
    const current = find(state, command.kind, command.id);
    if (command.kind === "interaction" && command.to === "answered")
      throw new Error("answer_required");
    if (command.kind === "task") {
      fence(current, command.revision);
      if (["review", "completed"].includes(command.to) && current.state !== "review")
        throw new Error("result_required");
      if (current.state === "review" && ["queued", "completed", "failed"].includes(command.to))
        throw new Error("review_required");
    }
    if (command.kind === "workspace" && command.to === "removed")
      requireConfirmation(command.confirmed, context);
    const field = command.kind === "turn" ? "status" : "state";
    transition(command.kind, String(current[field]), command.to);
    const next = { ...current, [field]: command.to };
    if (command.reason) next.holdReason = command.reason;
    if (command.kind === "interaction") {
      next.version = Number(current.version) + 1;
      next.resolvedAt = context.at;
    }
    if (command.kind === "task" && current.state === "failed")
      next.revision = Number(current.revision) + 1;
    if ("updatedAt" in next) next.updatedAt = context.at;
    return change(command.kind, next, context);
  }
  if (command.type === "answer") {
    const current = find(state, "interaction", command.id);
    if (current.state === "expired") throw new Error("interaction_expired: forward as a message");
    if (current.state !== "pending" || current.version !== command.version)
      throw new Error("interaction_conflict: already resolved or changed");
    if (
      context.actor.kind !== "human" &&
      !(context.actor.kind === "system" && command.answer.automatic)
    )
      throw new Error("human_answer_required");
    validateInteractionAnswer(current, command.answer);
    const fields = { items: current.items as { id: string; secret?: boolean }[] };
    assertNoPrivateValue(
      publicAnswerData(fields, command.answer),
      privateAnswerValues(fields, command.answer),
    );
    const answer = structuredClone(command.answer);
    answer.by = context.actor;
    answer.at = context.at;
    for (const item of current.items as { id: string; secret?: boolean }[]) {
      if (item.secret && answer.answers?.[item.id]) answer.answers[item.id] = { value: "[secret]" };
    }
    const next = {
      ...current,
      state: "answered",
      version: Number(current.version) + 1,
      resolution: answer,
      resolvedAt: context.at,
    };
    return { events: [event("interaction", next, context, "resolved")], result: next };
  }
  if (command.type === "review") {
    const current = find(state, "task", command.id);
    fence(current, command.revision);
    if (command.decision === "accept") requireChildrenAccepted(state, command.id);
    const to = { accept: "completed", changes: "queued", reject: "failed" }[command.decision];
    if (current.state !== "review") throw new Error("review_required: task is not awaiting review");
    transition("task", "review", to);
    const next: Record<string, unknown> = {
      ...current,
      state: to,
      reviewState: command.decision,
      updatedAt: context.at,
    };
    if (command.decision === "changes") {
      if (!command.feedback?.trim()) throw new Error("feedback_required");
      next.revision = Number(current.revision) + 1;
      next.brief = `${current.brief}\n\nReview feedback:\n${command.feedback}`;
    }
    return change("task", next, context);
  }
  const current = find(state, "task", command.id);
  fence(current, command.revision);
  if (command.summary.length > 2000 || command.files.length > 200)
    throw new Error("result_too_large");
  const to =
    command.status === "blocked"
      ? "blocked"
      : command.status === "failed"
        ? "failed"
        : current.reviewRequired
          ? "review"
          : "completed";
  transition("task", String(current.state), to);
  const result = {
    taskId: command.id,
    revision: command.revision,
    status: command.status,
    summary: command.summary,
    files: command.files,
    digest: command.summary.slice(0, 1500),
    auto: false,
    createdAt: context.at,
  };
  if (state.taskResult?.some((r) => r.taskId === command.id && r.revision === command.revision))
    throw new Error("result_already_submitted");
  const next = { ...current, state: to, updatedAt: context.at };
  return {
    events: [
      event("taskResult", result, context, "created"),
      event("task", next, context, "updated", 1),
    ],
    result,
  };
}

export function handle(state: DomainState, command: Command, context: CommandContext): Outcome {
  const outcome = execute(state, command, context);
  const securityAction =
    command.type === "answer"
      ? state.interaction?.find((i) => i.id === command.id)?.type === "approval"
      : (command.type === "create" || command.type === "update") &&
        ["agent", "grant", "rule"].includes(command.kind) &&
        command.confirmed === true;
  if (securityAction) {
    const record = {
      id: `audit:${context.commandId}`,
      actor: context.actor,
      action:
        command.type === "answer"
          ? "interaction.answer"
          : `${"kind" in command ? command.kind : "task"}.${command.type}`,
      target: "id" in command ? command.id : entityId(command.kind, command.value),
      result: "allowed",
      detail: { confirmed: context.actor.kind === "human" },
      at: context.at,
    };
    outcome.events.push(event("audit", record, context, "created", outcome.events.length));
  }
  return outcome;
}
