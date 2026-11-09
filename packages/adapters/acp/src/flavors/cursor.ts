import type { AgentEvent, InteractionAnswer, InteractionDraft } from "@zoltbot/protocol";
import type { AcpFlavor } from "../flavor.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("provider_protocol_error");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("provider_protocol_error");
  return value;
}
function id(value: unknown) {
  const result = text(value);
  if (result.length > 200) throw new Error("provider_protocol_error");
  return result;
}
function array(value: unknown, max = 100) {
  if (!Array.isArray(value) || value.length > max) throw new Error("provider_protocol_error");
  return value.map(object);
}
function questions(value: Record<string, unknown>) {
  const values = array(value.questions, 4);
  if (!values.length) throw new Error("provider_protocol_error");
  const ids = new Set<string>();
  return values.map((question) => {
    const questionId = id(question.id);
    if (ids.has(questionId)) throw new Error("provider_protocol_error");
    ids.add(questionId);
    const options = array(question.options, 8);
    const optionIds = new Set<string>();
    if (!options.length) throw new Error("provider_protocol_error");
    for (const option of options) {
      const optionId = id(option.id);
      if (optionIds.has(optionId)) throw new Error("provider_protocol_error");
      optionIds.add(optionId);
      text(option.label);
    }
    return {
      ...question,
      id: questionId,
      allowMultiple: question.allowMultiple === true,
      prompt: text(question.prompt).slice(0, 2000),
      options,
    };
  });
}
const base = {
  id: "pending",
  agentId: "pending",
  threadId: "pending",
  chain: [],
  urgency: "blocking" as const,
};
export function cursorFlavor(): AcpFlavor {
  const todos = new Map<
    string,
    { step: string; status: "pending" | "in_progress" | "completed" }
  >();
  return {
    id: "cursor",
    nativeVisibility: "no",
    readOnlyModes: ["ask", "plan"],
    testedVersions: "2026.10.22-27dcf5f",
    newSession: cursorFlavor,
    mcpInjection: "session_new",
    instructionInjection: "first_block",
    interactionCapabilities: {
      questions: "native",
      planReview: "native",
      questionFeatures: { multi: true, other: false, recommended: true },
    },
    chooseAuth(methods) {
      return methods.some((method) => method.id === "cursor_login")
        ? { methodId: "cursor_login" }
        : undefined;
    },
    mapExtensionRequest(method, raw): InteractionDraft | undefined {
      if (!["cursor/ask_question", "cursor/create_plan"].includes(method)) return undefined;
      const params = object(raw);
      id(params.toolCallId);
      if (method === "cursor/ask_question")
        return {
          ...base,
          type: "question",
          ...(typeof params.title === "string" ? { title: params.title } : {}),
          context: { toolInput: params },
          items: questions(params).map((question) => ({
            id: question.id,
            prompt: question.prompt,
            multi: question.allowMultiple === true,
            allowOther: false,
            options: question.options.map((option) => {
              const label = text(option.label);
              return {
                id: id(option.id),
                label: label.replace(/\s*\(Recommended\)\s*$/i, ""),
                recommended: /\(Recommended\)\s*$/i.test(label),
              };
            }),
          })),
        };
      return {
        ...base,
        type: "plan",
        ...(typeof params.name === "string" ? { title: params.name } : {}),
        context: { markdown: text(params.plan), toolInput: params },
        items: [
          {
            id: "plan",
            prompt: "Approve this plan?",
            choices: [{ id: "allow_once" }, { id: "reject_once" }],
          },
        ],
      };
    },
    mapExtensionAnswer(method, raw, answer: InteractionAnswer | undefined) {
      if (!answer || ["cancel", "timeout", "expire"].includes(answer.action))
        return { outcome: { outcome: "cancelled" } };
      if (method === "cursor/ask_question") {
        if (answer.action !== "accept")
          return {
            outcome: {
              outcome: "skipped",
              ...(answer.feedback ? { reason: answer.feedback } : {}),
            },
          };
        return {
          outcome: {
            outcome: "answered",
            answers: questions(object(raw)).map((question) => {
              const resolution = answer.answers?.[question.id],
                selected = resolution?.options ?? [];
              if (
                resolution?.other !== undefined ||
                !selected.length ||
                new Set(selected).size !== selected.length ||
                (question.allowMultiple !== true && selected.length > 1) ||
                selected.some(
                  (optionId) => !question.options.some((option) => option.id === optionId),
                )
              )
                throw new Error("invalid_question_answer");
              return { questionId: question.id, selectedOptionIds: selected };
            }),
          },
        };
      }
      if (method === "cursor/create_plan") {
        if (answer.action === "decline")
          return {
            outcome: {
              outcome: "rejected",
              ...(answer.feedback ? { reason: answer.feedback } : {}),
            },
          };
        if (
          answer.action === "accept" &&
          (answer.choice === undefined || answer.choice === "allow_once")
        )
          return { outcome: { outcome: "accepted" } };
      }
      return { outcome: { outcome: "cancelled" } };
    },
    mapExtensionNotification(method, raw): AgentEvent[] {
      if (!["cursor/update_todos", "cursor/task", "cursor/generate_image"].includes(method))
        return [];
      const params = object(raw);
      if (method === "cursor/update_todos") {
        if (params.merge !== true) todos.clear();
        for (const todo of array(params.todos)) {
          const todoId = id(todo.id);
          if (todo.status === "cancelled") {
            todos.delete(todoId);
            continue;
          }
          if (!["pending", "in_progress", "completed"].includes(String(todo.status)))
            throw new Error("provider_protocol_error");
          todos.set(todoId, {
            step: text(todo.content),
            status: todo.status as "pending" | "in_progress" | "completed",
          });
        }
        return [{ t: "plan.updated", turnId: "pending", entries: [...todos.values()] }];
      }
      const itemId = id(params.toolCallId);
      return [
        {
          t: "tool.started",
          turnId: "pending",
          itemId,
          name: method === "cursor/task" ? "Task" : "GenerateImage",
          kind: "other",
          input: params,
        },
        { t: "tool.done", itemId, status: "ok", output: params },
      ];
    },
  };
}
