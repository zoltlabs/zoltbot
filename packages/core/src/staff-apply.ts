import {
  type DomainEvent,
  parse,
  parseEvent,
  type Scope,
  type StaffAllowance,
  StaffAllowanceSchema,
  type StaffRequest,
  staffAllowanceKey,
} from "@zoltbot/protocol";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import { companyRecord } from "./company-changes.js";
import { createScopedChat } from "./hierarchy.js";
import { queueSystemNotice } from "./input-queue.js";
import { applyEvents, type DomainState } from "./projectors.js";
import { employeeInstructions, planStaffChange, readStaffAllowance } from "./staff.js";
import { createAssignedTask } from "./tasks.js";
import type { WorkspaceActor } from "./workspace-shape.js";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Collects events step by step, so each step sees the state the earlier ones produced. */
function collector(initial: DomainState, context: CommandContext) {
  const events: DomainEvent[] = [];
  let state = initial;
  let step = 0;
  return {
    get state() {
      return state;
    },
    add(outcome: Outcome) {
      events.push(...outcome.events);
      state = applyEvents(state, outcome.events);
      return outcome;
    },
    /** A context whose command id is unique to this step, for records that derive ids from it. */
    next(): CommandContext {
      return { ...context, commandId: `${context.commandId}:${step++}` };
    },
    done(result: Row): Outcome {
      return {
        events: events.map((event, index) => ({
          ...event,
          eventId: `${context.commandId}:${index}`,
        })),
        result,
      };
    },
  };
}
function allowanceEvent(
  state: DomainState,
  value: StaffAllowance,
  context: CommandContext,
): Outcome {
  const key = staffAllowanceKey(value.threadId);
  const exists = state.settings?.some((r) => r.key === key);
  return {
    events: [
      parseEvent({
        eventId: `${context.commandId}:0`,
        commandId: context.commandId,
        aggregateType: "settings",
        aggregateId: key,
        type: exists ? "settings.updated" : "settings.created",
        occurredAt: context.at,
        payload: { key, value: parse(StaffAllowanceSchema, value) },
      }),
    ],
    result: value,
  };
}
const audit = (
  state: DomainState,
  action: string,
  target: string,
  detail: Row,
  context: CommandContext,
) =>
  handle(
    state,
    {
      type: "create",
      kind: "audit",
      value: {
        id: `${context.commandId}:audit`,
        actor: context.actor,
        action,
        target,
        result: "allowed",
        detail,
        at: context.at,
      },
    },
    context,
  );
const notice = (state: DomainState, threadId: string, words: string, context: CommandContext) =>
  queueSystemNotice(
    state,
    { threadId, text: `[Organization change] ${words} This grants no extra permissions.` },
    `${context.commandId}:notice`,
    { ...context, actor: { kind: "system", id: "company" } },
  );

export interface StaffApproval {
  interactionId: string;
  /** The owner ticked the card's box: grant the allowance the card offered. */
  grantAllowance?: boolean;
}
/**
 * Applies a staff request. A request the plan says needs approval runs only with a human actor
 * and an approval, which also stands for the confirmation profile and archive changes need (I13).
 * `id` makes every created record's id stable, so a retried command creates nothing twice.
 */
export function applyStaffChange(
  initial: DomainState,
  actor: WorkspaceActor | undefined,
  request: StaffRequest,
  id: string,
  context: CommandContext,
  approval?: StaffApproval,
): Outcome {
  if (!actor && context.actor.kind !== "human") throw Error("human_approval_required");
  const plan = planStaffChange(initial, actor, request);
  const approved = context.actor.kind === "human" && (approval !== undefined || !actor);
  if (plan.reasons.length && !approved) throw Error("approval_required");
  const run = collector(initial, context);
  const detail: Row = {
    kind: request.kind,
    ...(actor ? { requestedBy: actor.threadId } : {}),
    ...(approval ? { interactionId: approval.interactionId, confirmed: true } : {}),
    ...(plan.allowance ? { allowance: true } : {}),
  };
  let target = "";
  if (request.kind === "add") {
    const { node, projectId, template, model, folders } = plan.resolved as {
      node: Scope;
      projectId: string;
      template: Row;
      model: string;
      folders: string[];
    };
    const profileId = `${id}-profile`;
    const employee = String(plan.resolved.name);
    run.add(
      handle(
        run.state,
        {
          type: "create",
          kind: "agent",
          value: {
            id: profileId,
            name: employee,
            avatar: employee.slice(0, 1).toUpperCase(),
            kind: "profile",
            definitionId: template.definitionId,
            ...(model ? { model } : {}),
            ...(text(template.effort) ? { effort: template.effort } : {}),
            permissionProfile: template.permissionProfile,
            instructions: employeeInstructions(request.role, folders, request.instructions ?? ""),
            ...(request.role.trim() ? { roleText: request.role.trim() } : {}),
            hidden: false,
            archived: false,
            createdAt: context.at,
            updatedAt: context.at,
          },
          ...(approved ? { confirmed: true } : {}),
        },
        run.next(),
      ),
    );
    run.add(
      createScopedChat(
        run.state,
        {
          id,
          agentId: profileId,
          projectId,
          node,
          kind: "side",
          title: employee,
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: context.at,
          lastActivityAt: context.at,
        },
        run.next(),
      ),
    );
    target = id;
    if (request.firstTask)
      run.add(
        createAssignedTask(
          run.state,
          {
            id: `${id}-task`,
            title: request.firstTask.title,
            brief: request.firstTask.brief,
            acceptance: "Complete the brief and submit evidence for review.",
            profileId,
            node,
            existingThreadId: id,
            ...(actor ? { accountableThreadId: actor.threadId } : {}),
          },
          run.next(),
        ),
      );
    const current = actor ? readStaffAllowance(run.state, actor.threadId) : undefined;
    if (plan.allowance && current)
      run.add(
        allowanceEvent(
          run.state,
          {
            ...current,
            used: current.used + 1,
            revision: current.revision + 1,
            updatedAt: context.at,
          },
          run.next(),
        ),
      );
    const offer = plan.preview.allowanceOffer;
    if (approval?.grantAllowance && actor && offer)
      run.add(
        allowanceEvent(
          run.state,
          {
            threadId: actor.threadId,
            projectId,
            max: offer.max,
            used: 0,
            models: offer.models,
            folders: offer.folders,
            interactionId: approval.interactionId,
            revision: (current?.revision ?? 0) + 1,
            grantedAt: context.at,
            updatedAt: context.at,
          },
          run.next(),
        ),
      );
  } else if (request.kind === "change") {
    const { thread, profile, changes, sharedWith } = plan.resolved as {
      thread: Row;
      profile: Row;
      changes: Row;
      sharedWith: number;
    };
    target = String(thread.id);
    const { name, ...profileChanges } = changes;
    // A shared profile keeps its name; only this chat is renamed.
    if (name !== undefined && !sharedWith) profileChanges.name = name;
    if (Object.keys(profileChanges).length)
      run.add(
        handle(
          run.state,
          {
            type: "update",
            kind: "agent",
            id: String(profile.id),
            changes: { ...profileChanges, updatedAt: context.at },
            confirmed: true,
          },
          run.next(),
        ),
      );
    if (name !== undefined)
      run.add(
        handle(
          run.state,
          {
            type: "update",
            kind: "thread",
            id: target,
            changes: { title: name, titleSource: "human" },
          },
          run.next(),
        ),
      );
  } else {
    const { thread, queued, accountable, destination, working } = plan.resolved as {
      thread: Row;
      queued: Row[];
      accountable: Row[];
      destination?: Row;
      working: boolean;
    };
    target = String(thread.id);
    let used = false;
    for (const [index, task] of queued.entries()) {
      if (!destination) break;
      const current = run.state.task?.find((r) => r.id === task.id) ?? task;
      const busy = (run.state.task ?? []).some(
        (r) =>
          r.threadId === destination.id &&
          r.id !== task.id &&
          !["completed", "failed", "cancelled"].includes(String(r.state)),
      );
      let threadId = String(destination.id);
      if (busy || used) {
        // The teammate's chat already holds an assignment, so the task gets its own chat.
        threadId = `${target}-moved-${index}`;
        run.add(
          createScopedChat(
            run.state,
            {
              id: threadId,
              agentId: destination.agentId,
              projectId: thread.projectId,
              node: (destination.node as Scope | undefined) ?? current.node,
              taskId: current.id,
              kind: "task",
              title: String(current.title),
              titleSource: "human",
              pinned: false,
              archived: false,
              createdAt: context.at,
              lastActivityAt: context.at,
            },
            run.next(),
          ),
        );
      } else {
        used = true;
        run.add(
          handle(
            run.state,
            { type: "update", kind: "thread", id: threadId, changes: { taskId: current.id } },
            run.next(),
          ),
        );
      }
      const old = run.state.thread?.find((r) => r.id === current.threadId);
      if (old && old.id !== thread.id && old.kind === "task" && old.taskId === current.id)
        run.add(
          handle(
            run.state,
            { type: "update", kind: "thread", id: String(old.id), changes: { archived: true } },
            run.next(),
          ),
        );
      run.add(
        companyRecord(
          "task",
          { ...current, threadId, ownerAgentId: destination.agentId, updatedAt: context.at },
          run.next(),
        ),
      );
    }
    for (const task of accountable) {
      if (!destination) break;
      const current = run.state.task?.find((r) => r.id === task.id) ?? task;
      const busy = ["running", "blocked"].includes(String(current.state));
      run.add(
        companyRecord(
          "task",
          busy
            ? { ...current, pendingAccountableThreadId: destination.id, updatedAt: context.at }
            : {
                ...current,
                accountableThreadId: destination.id,
                assignmentHistory: [
                  ...((current.assignmentHistory as unknown[]) ?? []),
                  { threadId: destination.id, at: context.at },
                ],
                updatedAt: context.at,
              },
          run.next(),
        ),
      );
    }
    // Running work finishes first; the daemon archives the chat once it is idle.
    run.add(
      handle(
        run.state,
        {
          type: "update",
          kind: "thread",
          id: target,
          changes: working ? { archiveWhenIdle: true } : { archived: true },
        },
        run.next(),
      ),
    );
    const allowance = readStaffAllowance(run.state, target);
    if (allowance?.max)
      run.add(
        allowanceEvent(
          run.state,
          { ...allowance, max: 0, revision: allowance.revision + 1, updatedAt: context.at },
          run.next(),
        ),
      );
    if (destination && (queued.length || accountable.length))
      run.add(
        notice(
          run.state,
          String(destination.id),
          `${String(thread.title)} was archived. ${queued.length ? `Their queued tasks are yours now: ${queued.map((r) => `"${String(r.title)}"`).join(", ")}.` : ""}${accountable.length ? ` You are now accountable for ${accountable.length} task${accountable.length === 1 ? "" : "s"} they delegated.` : ""}`,
          run.next(),
        ),
      );
    detail.moveTo = destination?.id;
    detail.moved = queued.map((r) => r.id);
    detail.finishingFirst = working;
  }
  run.add(audit(run.state, `staff.${request.kind}`, target, detail, run.next()));
  return run.done({
    kind: request.kind,
    threadId: target,
    ...(request.kind === "archive"
      ? { archived: !(plan.resolved as { working: boolean }).working, moved: detail.moved }
      : {}),
    ...(plan.allowance ? { allowance: true } : {}),
  });
}

/** The owner sets, changes or turns off (max 0) a manager's standing allowance. */
export function setStaffAllowance(
  state: DomainState,
  input: { threadId: string; max: number; models?: string[]; folders?: string[] },
  context: CommandContext,
): Outcome {
  if (context.actor.kind !== "human") throw Error("human_approval_required");
  const thread = state.thread?.find((r) => r.id === input.threadId && !r.archived);
  if (!thread || thread.kind !== "manager" || !thread.projectId) throw Error("manager_unavailable");
  const current = readStaffAllowance(state, input.threadId);
  const run = collector(state, context);
  run.add(
    allowanceEvent(
      state,
      {
        threadId: input.threadId,
        projectId: String(thread.projectId),
        max: input.max,
        used: current && current.max > 0 ? current.used : 0,
        models: input.models ?? current?.models ?? [],
        folders: input.folders ?? current?.folders ?? [],
        revision: (current?.revision ?? 0) + 1,
        grantedAt: current?.grantedAt ?? context.at,
        updatedAt: context.at,
      },
      run.next(),
    ),
  );
  run.add(
    audit(
      run.state,
      "staff.allowance",
      input.threadId,
      { max: input.max, confirmed: true },
      run.next(),
    ),
  );
  return run.done({ threadId: input.threadId, max: input.max });
}
