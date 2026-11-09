import { type InteractionAnswer, InteractionDraftSchema, parse } from "@zoltbot/protocol";

export function piQuestion(
  frame: Record<string, unknown>,
  ids: { id: string; agentId: string; threadId: string; turnId: string },
) {
  const invalid = () => {
    throw new Error("invalid_native_question");
  };
  if (
    !["select", "input"].includes(String(frame.method)) ||
    typeof frame.title !== "string" ||
    !frame.title.trim() ||
    frame.title.length > 2000
  )
    return invalid();
  const select = frame.method === "select";
  const labels = select ? frame.options : [];
  if (
    !Array.isArray(labels) ||
    (select && (!labels.length || labels.length > 8)) ||
    labels.some((label) => typeof label !== "string" || !label || label.length > 16000)
  )
    return invalid();
  if (
    frame.placeholder !== undefined &&
    (typeof frame.placeholder !== "string" || frame.placeholder.length > 2000)
  )
    return invalid();
  if (
    frame.timeout !== undefined &&
    (typeof frame.timeout !== "number" || !Number.isFinite(frame.timeout) || frame.timeout <= 0)
  )
    return invalid();
  const options = (labels as string[]).map((label, index) => ({ id: String(index), label }));
  const interaction = parse(InteractionDraftSchema, {
    ...ids,
    nativeRef: ids.id,
    type: "question",
    chain: [],
    urgency: "blocking",
    title: frame.title,
    context: {
      toolInput: {
        ...(typeof frame.placeholder === "string" ? { placeholder: frame.placeholder } : {}),
      },
    },
    items: [
      {
        id: "question",
        prompt: frame.title,
        multi: false,
        allowOther: !select,
        ...(select ? { options } : {}),
      },
    ],
    ...(typeof frame.timeout === "number"
      ? { timeout: { seconds: frame.timeout / 1000, onTimeout: "reject" } }
      : {}),
  });
  return {
    interaction,
    reply(answer: InteractionAnswer): { value: string } | { cancelled: true } {
      if (answer.action !== "accept") return { cancelled: true };
      const value = answer.answers?.question;
      const fail = () => {
        throw new Error("invalid_question_answer");
      };
      if (
        !value ||
        Object.keys(answer.answers ?? {}).some((id) => id !== "question") ||
        value.value !== undefined
      )
        return fail();
      if (select) {
        const selected = value.options ?? [];
        const option = options.find((option) => option.id === selected[0]);
        if (selected.length !== 1 || !option || value.other !== undefined) return fail();
        return { value: option.label };
      }
      if (value.options?.length || typeof value.other !== "string" || !value.other.trim())
        return fail();
      return { value: value.other };
    },
  };
}
