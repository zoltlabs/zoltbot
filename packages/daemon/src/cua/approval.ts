import { queueHumanInput, requestInteraction } from "@zoltbot/core";
import type { ToolActor } from "@zoltbot/hostmcp";
import { HOST_WORKSPACE_REF, type Interaction, type InteractionAnswer } from "@zoltbot/protocol";
import type { RuntimeContext } from "../api.js";

export function consent(context: RuntimeContext, actor: ToolActor, id: string) {
  const existing = context.store.record("interaction", id);
  if (existing) {
    const answer = existing.resolution as InteractionAnswer | undefined;
    return answer?.by.kind === "human" &&
      answer.action === "accept" &&
      answer.choice === "allow_once"
      ? "approved"
      : answer || existing.state !== "pending"
        ? "denied"
        : "pending";
  }
  const before = context.store.lastSeq();
  context.store.dispatch(id, (state) =>
    requestInteraction(
      state,
      {
        id,
        agentId: actor.agentId,
        threadId: actor.threadId,
        type: "approval",
        title: "Control native apps",
        context: {
          toolName: "native_app",
          markdown:
            "Allow this chat to inspect open macOS apps (including screenshots) and send background input? App content is sent to your agent provider. Cua Driver may start its signed helper. Background input can still affect focus in some apps. Only one Zoltbot controller runs at a time. Access ends on disconnect or after five idle minutes. Foreground control, app launches and desktop-wide input are excluded.",
          toolInput: { cuaSession: actor.sessionId },
        },
        items: [
          {
            id: "native",
            header: "Native apps",
            prompt: "Allow native app inspection and background input for this run?",
            choices: [{ id: "allow_once" }, { id: "reject_once" }],
          },
        ],
        chain: [{ kind: "agent", id: actor.agentId }],
        urgency: "background",
        nativeRef: HOST_WORKSPACE_REF,
      },
      `${id}:item`,
      { commandId: id, at: new Date().toISOString(), actor: { kind: "agent", id: actor.agentId } },
    ),
  );
  context.publish(context.store.eventsSince(before));
  return "pending";
}

export async function respondCuaApproval(
  context: RuntimeContext,
  request: Interaction,
  answer: InteractionAnswer,
) {
  if (answer.by.kind !== "human") throw Error("human_answer_required");
  const id = `cua-answer:${request.id}`;
  const before = context.store.lastSeq();
  context.store.dispatch(id, (state) =>
    queueHumanInput(
      state,
      {
        threadId: request.threadId,
        input: [
          {
            type: "text",
            text: `[Zoltbot] Native app access ${answer.action === "accept" && answer.choice === "allow_once" ? "approved; call native_app connect to continue" : "declined"}.`,
          },
        ],
        mode: "queue",
        sourceInteractionId: request.id,
      },
      `${id}:input`,
      { commandId: id, at: new Date().toISOString(), actor: answer.by },
    ),
  );
  context.publish(context.store.eventsSince(before));
  await context.wake(request.threadId);
}
