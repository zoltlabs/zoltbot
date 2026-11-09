import {
  checkFlatForm,
  type Interaction,
  type InteractionAnswer,
  parse,
  ResolutionSchema,
} from "@zoltbot/protocol";

export function validateInteractionAnswer(
  current: Record<string, unknown>,
  answer: InteractionAnswer,
) {
  parse(ResolutionSchema, answer);
  const items = current.items as Interaction["items"];
  const answers = answer.answers ?? {};
  const invalid = () => {
    throw new Error("invalid_interaction_answer");
  };
  if (Object.keys(answers).some((id) => !items.some((item) => item.id === id))) invalid();
  if (current.type === "question" && answer.action === "accept") {
    for (const item of items) {
      if (!Object.hasOwn(answers, item.id)) invalid();
      const value = answers[item.id];
      if (!value) {
        invalid();
        continue;
      }
      const selected = value.options ?? [];
      if (new Set(selected).size !== selected.length || (!item.multi && selected.length > 1))
        invalid();
      if (selected.some((id) => !item.options?.some((option) => option.id === id))) invalid();
      if (value.other !== undefined && (item.allowOther === false || !value.other.trim()))
        invalid();
      if (!item.multi && selected.length && value.other !== undefined) invalid();
      if (value.value !== undefined && !item.secret) invalid();
      if (!selected.length && value.other === undefined && value.value === undefined) invalid();
    }
  }
  const offered = (id: string) =>
    items.some((item) => item.choices?.some((choice) => choice.id === id));
  if (current.type === "approval" && answer.action === "accept") {
    if (!answer.choice || !offered(answer.choice)) invalid();
  }
  // A plan review may offer choices such as allow_accept_edits; any choice sent must be offered.
  if (current.type === "plan" && answer.choice !== undefined && !offered(answer.choice)) invalid();
  if (current.type === "form" && answer.action === "accept") {
    for (const item of items) {
      if (!Object.hasOwn(answers, item.id)) invalid();
      const value = answers[item.id];
      if (
        !value ||
        value.options !== undefined ||
        value.other !== undefined ||
        !checkFlatForm(item.schema, value.value)
      )
        invalid();
    }
  }
}
