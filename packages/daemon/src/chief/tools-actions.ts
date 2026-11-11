import { randomUUID } from "node:crypto";
import {
  applyEvents,
  createScopedChat,
  type DomainState,
  handle,
  type Outcome,
  queueAgentInput,
  queueHumanInput,
} from "@zoltbot/core";
import type { ToolInvocation } from "@zoltbot/hostmcp";
import type { Interaction, InteractionAnswer } from "@zoltbot/protocol";
import type { RuntimeContext } from "../api.js";
import { chiefKeys, chiefName, chiefThreadId, settingCommand } from "./identity.js";
import { chiefInbox } from "./inbox.js";

import {
  type ChiefAction,
  type ChiefRelayedAnswer,
  describe,
  hash,
  liveThread,
  text,
} from "./tools-model.js";

/** Returns an applied CompanyPlan id when the chief already has approved authority over `chatId`. */
export function authorizedChiefMessagePlan(
  state: DomainState,
  actorThreadId: string,
  chatId: string,
): string | undefined {
  const target = liveThread(state, chatId);
  if (!target) return undefined;
  const node = target.node as { type?: string; id?: string } | undefined;
  const projectId =
    text(target.projectId) ||
    (node?.type === "project"
      ? text(node.id)
      : node?.type === "subproject"
        ? text(state.subproject?.find((s) => s.id === node.id)?.projectId)
        : "");
  if (!projectId) return undefined;
  const appliedPlans = (state.companyPlan ?? []).filter(
    (plan) =>
      plan.state === "applied" &&
      plan.projectId === projectId &&
      plan.requestedBy === actorThreadId,
  );
  if (!appliedPlans.length) return undefined;
  const isCoordinatedTarget =
    target.kind === "manager" ||
    (state.managerRemit ?? []).some((r) => r.projectId === projectId && r.threadId === chatId) ||
    (state.initiativeRecord ?? []).some(
      (r) =>
        r.projectId === projectId &&
        r.managerThreadId === chatId &&
        !["completed", "cancelled"].includes(text(r.state)),
    ) ||
    (state.task ?? []).some(
      (r) =>
        r.projectId === projectId &&
        !["completed", "cancelled"].includes(text(r.state)) &&
        (r.accountableThreadId === chatId || r.threadId === chatId),
    );
  if (!isCoordinatedTarget) return undefined;
  return text(appliedPlans.at(-1)?.id) || undefined;
}

/** Delivers an ordinary handoff or follow-up directly under an already-approved CompanyPlan. */
export async function sendAuthorizedChiefMessage(
  context: RuntimeContext,
  call: ToolInvocation,
  args: { key: string; chatId: string; text: string },
  authorityPlanId: string,
) {
  const base = hash([call.actor.threadId, "chief_message_chat", args.key]);
  const messageId = `chief-msg-${base.slice(0, 24)}`;
  const commandId = `chief-direct:${base}`;
  const check = await context.privacy.prepareData(args);
  const before = context.store.lastSeq();
  let produced = false;
  const receipt = context.store.dispatch<{ chatId: string; text: string; authorityPlanId: string }>(
    commandId,
    (state) => {
      check(state);
      const target = liveThread(state, args.chatId);
      if (!target) throw new Error("chat_unavailable");
      const currentPlan = authorizedChiefMessagePlan(state, call.actor.threadId, args.chatId);
      if (!currentPlan) throw new Error("approval_required");
      produced = true;
      const at = new Date().toISOString();
      const actor = { kind: "agent" as const, id: call.actor.agentId };
      const body = `[Message from ${chiefName(state)}, under approved plan ${currentPlan}]\n${args.text}`;
      const message = handle(
        state,
        {
          type: "create",
          kind: "message",
          value: {
            id: messageId,
            thread: target.id,
            fromThread: call.actor.threadId,
            from: actor,
            to: [{ kind: "agent", id: target.agentId }],
            kind: "message",
            expectsReply: false,
            priority: "normal",
            delivery: "next_turn",
            root: messageId,
            hops: 1,
            ttlHops: 6,
            origin: "agent",
            body: [{ type: "text", text: body }],
            createdAt: at,
          },
        },
        { commandId: `${commandId}:message`, at, actor },
      );
      let next = applyEvents(state, message.events);
      const audit = handle(
        next,
        {
          type: "create",
          kind: "audit",
          value: {
            id: `${messageId}:audit`,
            actor,
            action: "chief.message_chat",
            target: target.id,
            result: "allowed",
            detail: {
              authorityPlanId: currentPlan,
              chiefThreadId: call.actor.threadId,
              messageId,
            },
            at,
          },
        },
        { commandId: `${commandId}:audit`, at, actor },
      );
      next = applyEvents(next, audit.events);
      const queued = queueAgentInput(next, messageId, `${messageId}:input`, {
        commandId: `${commandId}:queue`,
        at,
        actor,
      });
      const events = [...message.events, ...audit.events, ...queued.events].map((e, i) => ({
        ...e,
        eventId: `${commandId}:${i}`,
      }));
      return {
        events,
        result: { chatId: args.chatId, text: args.text, authorityPlanId: currentPlan },
      };
    },
  );
  if (receipt.result.chatId !== args.chatId || receipt.result.text !== args.text)
    throw new Error("command_receipt_conflict");
  if (produced) context.publish(context.store.eventsSince(before));
  try {
    await context.wake(args.chatId);
    return {
      status: "sent",
      chatId: args.chatId,
      authorityPlanId: receipt.result.authorityPlanId || authorityPlanId,
      delivered: "queued",
    };
  } catch {
    return {
      status: "sent",
      chatId: args.chatId,
      authorityPlanId: receipt.result.authorityPlanId || authorityPlanId,
      delivered: "queued_not_woken",
    };
  }
}
/** Applies or declines a chief approval and tells the chief through its input queue. */
export async function respondChiefApproval(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
) {
  if (answer.by.kind !== "human") throw new Error("human_answer_required");
  const action = (request.context?.toolInput as { chiefAction?: ChiefAction } | undefined)
    ?.chiefAction;
  if (!action) throw new Error("chief_action_missing");
  const approved = answer.action === "accept" && answer.choice === "allow_once";
  if (approved && action.tool === "chief_answer")
    return relayAnswers(context, request, answer, action.items);
  const commandId = `chief-approval:${request.id}`;
  const tell = (state: DomainState, message: string, at: string, suffix: string) =>
    queueHumanInput(
      state,
      {
        threadId: request.threadId,
        input: [{ type: "text", text: `[Zoltbot] ${message}` }],
        mode: "queue",
        sourceInteractionId: request.id,
      },
      `${commandId}:${suffix}`,
      { commandId: `${commandId}:${suffix}`, at, actor: answer.by },
    );
  const before = context.store.lastSeq();
  let wake: string | undefined;
  try {
    context.store.dispatch(commandId, (state) => {
      const at = new Date().toISOString();
      if (!approved) {
        const why = answer.feedback?.trim() ? ` Reason: ${answer.feedback.trim()}` : "";
        return tell(
          state,
          `The user declined: ${describe(state, action).split("\n")[0]}${why}`,
          at,
          "declined",
        );
      }
      if (!chiefThreadId(state) || chiefThreadId(state) !== request.threadId)
        throw new Error("chief_unavailable");
      const applied = apply(state, request, action, {
        commandId,
        at,
        actor: { kind: "agent", id: request.agentId },
      });
      const next = applyEvents(state, applied.events);
      const told = tell(next, `Approved: ${String(applied.result.done)}`, at, "approved");
      if (action.tool === "chief_start_chat" || action.tool === "chief_message_chat")
        wake = action.chatId;
      return {
        events: [...applied.events, ...told.events].map((event, index) => ({
          ...event,
          eventId: `${commandId}:${index}`,
        })),
        result: applied.result,
      };
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "chief_action_failed";
    const failed = `${commandId}:failed:${randomUUID()}`;
    context.store.dispatch(failed, (state) =>
      tell(
        state,
        `Approved, but it could not be done (${code.slice(0, 80)}).`,
        new Date().toISOString(),
        `failed:${failed.slice(-36)}`,
      ),
    );
  }
  context.publish(context.store.eventsSince(before));
  if (approved && action.tool === "chief_stop_chat")
    try {
      await context.interrupt?.(action.chatId, action.turnId, `${commandId}:interrupt`);
    } catch {}
  for (const id of [wake, request.threadId])
    if (id)
      try {
        await context.wake(id);
      } catch {}
}

/**
 * The user confirmed answers they stated to the chief. Each is sent as theirs; the audit names the
 * chief as the relay. Items answered elsewhere or changed since are skipped and reported.
 */
async function relayAnswers(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
  items: ChiefRelayedAnswer[],
) {
  const commandId = `chief-approval:${request.id}`;
  if (context.store.receipt(commandId)) return;
  const state = context.store.snapshot(["interaction"]);
  const current = new Map((state.interaction ?? []).map((row) => [text(row.id), row]));
  const fresh = items.filter((item) => {
    const row = current.get(item.interactionId);
    return row?.state === "pending" && row.version === item.version;
  });
  const skipped = items.filter((item) => !fresh.includes(item));
  let failed = "";
  if (fresh.length)
    try {
      if (!context.answer) throw new Error("interaction_runtime_unavailable");
      await context.answer(
        fresh.map((item) => ({
          id: item.interactionId,
          version: item.version,
          answer: { ...item.answer, by: answer.by, at: new Date().toISOString() },
        })),
        `${commandId}:batch`,
      );
    } catch (error) {
      failed = error instanceof Error ? error.message.slice(0, 80) : "answer_failed";
    }
  const before = context.store.lastSeq();
  context.store.dispatch(commandId, (state) => {
    const at = new Date().toISOString();
    let next = state;
    const events: Outcome["events"] = [];
    if (!failed)
      for (const item of fresh) {
        const out = handle(
          next,
          {
            type: "create",
            kind: "audit",
            value: {
              id: `${commandId}:audit:${item.interactionId}`,
              actor: answer.by,
              action: "chief.answer",
              target: item.interactionId,
              result: "allowed",
              detail: {
                relay: { kind: "agent", id: request.agentId },
                chiefThreadId: request.threadId,
                approvalId: request.id,
                summary: item.summary,
              },
              at,
            },
          },
          { commandId: `${commandId}:audit:${item.interactionId}`, at, actor: answer.by },
        );
        events.push(...out.events);
        next = applyEvents(next, out.events);
      }
    const problems = [
      failed ? `Approved, but the answers could not be sent (${failed}).` : "",
      skipped.length
        ? `Skipped ${skipped.length} that changed or were answered elsewhere: ${skipped
            .map((item) => `"${item.title}"`)
            .join(", ")}.`
        : "",
    ].filter(Boolean);
    // Nothing to say when every answer went through: the card already shows it.
    if (problems.length) {
      const told = queueHumanInput(
        next,
        {
          threadId: request.threadId,
          input: [{ type: "text", text: `[Zoltbot] ${problems.join(" ")}` }],
          mode: "queue",
          sourceInteractionId: request.id,
        },
        `${commandId}:relay`,
        { commandId: `${commandId}:relay`, at, actor: answer.by },
      );
      events.push(...told.events);
    }
    return {
      events: events.map((event, index) => ({ ...event, eventId: `${commandId}:${index}` })),
      result: { sent: failed ? 0 : fresh.length, skipped: skipped.length },
    };
  });
  context.publish(context.store.eventsSince(before));
  if (failed || skipped.length)
    try {
      await context.wake(request.threadId);
    } catch {}
}

function apply(
  state: DomainState,
  request: Interaction,
  action: ChiefAction,
  context: { commandId: string; at: string; actor: { kind: "agent"; id: string } },
): Outcome {
  const name = chiefName(state);
  if (action.tool === "chief_answer") throw new Error("chief_answer_relayed_separately");
  if (action.tool === "chief_stop_chat") {
    if (!liveThread(state, action.chatId)) throw new Error("chat_unavailable");
    return { events: [], result: { done: `stopping the running turn in chat ${action.chatId}.` } };
  }
  let events: Outcome["events"] = [];
  if (action.tool === "chief_start_chat") {
    const created = createScopedChat(
      state,
      {
        id: action.chatId,
        agentId: action.profileId,
        projectId: action.projectId,
        node: action.node,
        kind: "side",
        title: action.title,
        titleSource: "provider",
        pinned: false,
        archived: false,
        createdAt: context.at,
        lastActivityAt: context.at,
      },
      { ...context, commandId: `${context.commandId}:chat` },
    );
    events = created.events;
  }
  const target = liveThread(applyEvents(state, events), action.chatId);
  if (!target) throw new Error("chat_unavailable");
  const messageId =
    action.tool === "chief_message_chat" ? action.messageId : `${action.chatId}:brief`;
  const body =
    action.tool === "chief_start_chat"
      ? `[Brief from ${name}, the user's main agent; the user approved it.]\n${action.brief}`
      : `[Message from ${name}, the user's main agent; the user approved it.]\n${action.text}`;
  const message = handle(
    applyEvents(state, events),
    {
      type: "create",
      kind: "message",
      value: {
        id: messageId,
        thread: target.id,
        fromThread: request.threadId,
        from: context.actor,
        to: [{ kind: "agent", id: target.agentId }],
        kind: action.tool === "chief_start_chat" ? "task" : "message",
        expectsReply: false,
        priority: "normal",
        delivery: "next_turn",
        root: messageId,
        hops: 1,
        ttlHops: 6,
        origin: "agent",
        body: [{ type: "text", text: body }],
        createdAt: context.at,
      },
    },
    { ...context, commandId: `${context.commandId}:message` },
  );
  events = [...events, ...message.events];
  const audit = handle(
    applyEvents(state, events),
    {
      type: "create",
      kind: "audit",
      value: {
        id: `${messageId}:audit`,
        actor: context.actor,
        action: `chief.${action.tool.slice(6)}`,
        target: target.id,
        result: "allowed",
        detail: { interactionId: request.id, chiefThreadId: request.threadId, messageId },
        at: context.at,
      },
    },
    { ...context, commandId: `${context.commandId}:audit` },
  );
  events = [...events, ...audit.events];
  const queued = queueAgentInput(applyEvents(state, events), messageId, `${messageId}:input`, {
    ...context,
    commandId: `${context.commandId}:queue`,
  });
  events = [...events, ...queued.events];
  return {
    events,
    result: {
      done:
        action.tool === "chief_start_chat"
          ? `started chat "${action.title}" (${action.chatId}) and sent your brief.`
          : `sent your message to chat ${action.chatId}.`,
    },
  };
}

/** The user's answer on an idea Zolt promoted. "Start it" asks Zolt to draft the brief. */
export async function respondChiefIdea(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
) {
  const idea = (request.context?.toolInput as { chiefIdea?: { ids?: string[]; title?: string } })
    ?.chiefIdea;
  if (!idea) throw new Error("chief_idea_missing");
  const picked = answer.answers?.idea?.options?.[0];
  const choice: "start" | "later" | "never" =
    answer.action === "accept" && (picked === "start" || picked === "never") ? picked : "later";
  const commandId = `chief-idea-answer:${request.id}`;
  if (context.store.receipt(commandId)) return;
  const before = context.store.lastSeq();
  context.store.dispatch(commandId, (state) => {
    const at = new Date().toISOString();
    const ids = idea.ids ?? [];
    const events: Outcome["events"] = [];
    let next = state;
    if (ids.length) {
      const entries = chiefInbox(state).map((entry) =>
        ids.includes(entry.id) ? { ...entry, answer: choice } : entry,
      );
      const out = handle(state, settingCommand(state, chiefKeys.inbox, { entries }), {
        commandId: `${commandId}:inbox`,
        at,
        actor: answer.by,
      });
      events.push(...out.events);
      next = applyEvents(next, out.events);
    }
    if (choice === "start") {
      const told = queueHumanInput(
        next,
        {
          threadId: request.threadId,
          input: [
            {
              type: "text",
              text: `[Zoltbot] The user wants to start the idea "${idea.title ?? ""}". Propose chief_start_chat with a complete brief.`,
            },
          ],
          mode: "queue",
          sourceInteractionId: request.id,
        },
        `${commandId}:start`,
        { commandId: `${commandId}:start`, at, actor: answer.by },
      );
      events.push(...told.events);
    }
    return {
      events: events.map((event, index) => ({ ...event, eventId: `${commandId}:${index}` })),
      result: { choice },
    };
  });
  context.publish(context.store.eventsSince(before));
  if (choice === "start")
    try {
      await context.wake(request.threadId);
    } catch {}
}
