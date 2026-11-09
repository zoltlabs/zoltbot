import type { InteractionAnswer, InteractionDraft } from "@zoltbot/protocol";
import { Ajv } from "ajv";
import { object } from "./schema.js";

const text = (value: unknown) => (typeof value === "string" ? value : "");
function questions(params: Record<string, unknown>) {
  const list = Array.isArray(params.questions) ? params.questions.map(object) : [];
  if (!list.length || list.length > 4 || new Set(list.map((q) => q.id)).size !== list.length)
    throw new Error("provider_protocol_error");
  return list;
}
export function codexInteraction(
  method: string,
  params: Record<string, unknown>,
  ids: { id: string; agentId: string; threadId: string },
): InteractionDraft {
  const base = {
    ...ids,
    ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
    nativeRef: ids.id,
    chain: [],
    urgency: "blocking" as const,
  };
  if (method === "item/tool/requestUserInput")
    return {
      ...base,
      urgency: params.isBlocking === false ? "background" : "blocking",
      type: "question",
      items: questions(params).map((q) => ({
        id: text(q.id),
        header: text(q.header).slice(0, 12),
        prompt: text(q.question),
        multi: q.multiSelect === true,
        allowOther: q.isOther === true,
        secret: q.isSecret === true,
        ...(Array.isArray(q.options)
          ? {
              options: q.options.map((value, index) => {
                const option = object(value);
                const label = text(option.label);
                return {
                  id: String(index),
                  label: label.replace(/\s*\(Recommended\)\s*$/i, ""),
                  description: text(option.description),
                  recommended: /\(Recommended\)\s*$/i.test(label),
                };
              }),
            }
          : {}),
      })),
    };
  if (method === "mcpServer/elicitation/request") {
    if (params.mode === "url")
      return {
        ...base,
        type: "question",
        context: { markdown: `${text(params.message)}\n\n${text(params.url)}` },
        items: [
          {
            id: "consent",
            prompt: text(params.message),
            options: [
              { id: "continue", label: "Continue" },
              { id: "cancel", label: "Cancel" },
            ],
          },
        ],
      };
    return {
      ...base,
      type: "form",
      title: text(params.message),
      items: [{ id: "form", prompt: text(params.message), schema: params.requestedSchema }],
    };
  }
  if (
    ![
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(method)
  )
    throw new Error("unsupported_server_request");
  return {
    ...base,
    type: "approval",
    title:
      method === "item/permissions/requestApproval" ? "Additional permissions" : "Tool permission",
    context: {
      ...(typeof params.command === "string" ? { command: params.command } : {}),
      ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
      ...(typeof params.reason === "string" ? { markdown: params.reason } : {}),
      toolInput: params.permissions ?? params,
    },
    items: [
      {
        id: "approval",
        prompt: text(params.reason) || "Allow this operation?",
        choices: [{ id: "allow_once" }, { id: "allow_session" }, { id: "reject_once" }],
      },
    ],
  };
}
export function codexAnswer(
  method: string,
  params: Record<string, unknown>,
  answer: InteractionAnswer,
): unknown {
  if (method === "item/tool/requestUserInput") {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions(params)) {
      const id = text(question.id);
      const resolution = answer.answers?.[id];
      const options = Array.isArray(question.options) ? question.options.map(object) : [];
      const values = (resolution?.options ?? []).map((optionId) => {
        if (!/^(?:0|[1-9]\d*)$/.test(optionId)) throw new Error("invalid_question_answer");
        const option = options[Number(optionId)];
        if (!option) throw new Error("invalid_question_answer");
        return text(option.label);
      });
      if (resolution?.other !== undefined) {
        if (question.isOther !== true) throw new Error("invalid_question_answer");
        values.push(resolution.other);
      }
      answers[id] = { answers: answer.action === "accept" ? values : [] };
    }
    return { answers };
  }
  if (method === "mcpServer/elicitation/request") {
    const action =
      answer.action === "accept" ? "accept" : answer.action === "decline" ? "decline" : "cancel";
    if (action !== "accept" || params.mode === "url") return { action };
    const content = answer.answers?.form?.value;
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(
      object(params.requestedSchema),
    );
    if (!validate(content)) throw new Error("invalid_form_answer");
    return { action, content };
  }
  if (
    ![
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ].includes(method)
  )
    throw new Error("unsupported_server_request");
  const allowed =
    answer.action === "accept" &&
    (answer.choice === undefined ||
      answer.choice === "allow_once" ||
      answer.choice === "allow_session");
  if (method === "item/permissions/requestApproval")
    return {
      permissions: allowed ? params.permissions : {},
      scope: allowed && answer.choice === "allow_session" ? "session" : "turn",
    };
  return {
    decision: allowed
      ? answer.choice === "allow_session"
        ? "acceptForSession"
        : "accept"
      : answer.action === "decline"
        ? "decline"
        : "cancel",
  };
}
