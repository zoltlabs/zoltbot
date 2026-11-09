import type { Interaction } from "@zoltbot/protocol";
import type { ChiefRecommendation } from "../chief/data.js";
import type { AnswerDraft } from "./actions.js";
import { requestChoices } from "./request-data.js";

/**
 * The answer to send for "Accept" and batch review: Zolt's recommendation when it made one, else
 * the request's own recommended options. Mirrors the daemon's relayedAnswer, so an accepted
 * recommendation is exactly what Zolt would have sent.
 */
export function recommendedAnswer(
  request: Interaction,
  recommend?: ChiefRecommendation,
): AnswerDraft | undefined {
  if (request.state !== "pending" || !request.items.length) return undefined;
  if (request.items.some((item) => item.secret)) return undefined;
  if (recommend) {
    const words = recommend.text?.trim();
    const feedback = words ? { feedback: words } : {};
    if (recommend.decision === "decline") return { action: "decline", ...feedback };
    if (request.type === "approval" || request.type === "plan") {
      if (recommend.decision !== "approve") return undefined;
      const once = requestChoices(request).has("allow_once");
      return { action: "accept", ...(once ? { choice: "allow_once" } : {}), ...feedback };
    }
    const [item] = request.items;
    if (request.type !== "question" || request.items.length !== 1 || !item) return undefined;
    if (recommend.choice) {
      const option = item.options?.find((entry) => entry.id === recommend.choice);
      return option
        ? { action: "accept", answers: { [item.id]: { options: [option.id] } } }
        : undefined;
    }
    if (!words || (item.options?.length && !item.allowOther)) return undefined;
    return { action: "accept", answers: { [item.id]: { other: words } } };
  }
  if (request.type !== "question") return undefined;
  const answers: NonNullable<AnswerDraft["answers"]> = {};
  for (const item of request.items) {
    const selected = (item.options ?? []).filter((option) => option.recommended);
    if (!selected.length || (!item.multi && selected.length !== 1)) return undefined;
    answers[item.id] = { options: selected.map((option) => option.id) };
  }
  return { action: "accept", answers };
}

/** "Approve once", `Decline, saying "not yet"`, "Staging": what an answer does, in a few words. */
export function describeAnswer(request: Interaction, draft: AnswerDraft): string {
  const said = draft.feedback ? `, saying "${draft.feedback}"` : "";
  if (draft.action === "decline") return `Decline${said}`;
  if (draft.action === "cancel") return "Skip";
  if (request.type !== "question")
    return `Approve${draft.choice === "allow_once" ? " once" : ""}${said}`;
  return request.items
    .map((item) => {
      const answer = draft.answers?.[item.id];
      if (answer?.other) return `"${answer.other}"`;
      return (item.options ?? [])
        .filter((option) => answer?.options?.includes(option.id))
        .map((option) => option.label)
        .join(", ");
    })
    .join(" · ");
}
