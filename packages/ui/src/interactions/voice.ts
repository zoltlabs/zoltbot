import type { Interaction } from "@zoltbot/protocol";
import type { ChiefRecommendation } from "../chief/data.js";
import type { AnswerDraft } from "./actions.js";
import { recommendedAnswer } from "./batch.js";
import { requestChoices } from "./request-data.js";

// Speaking to Needs you: a short command acts on the selected
// request at once, like its keyboard shortcut; anything longer is a reply you confirm first.

export type VoiceIntent =
  | { kind: "answer"; draft: AnswerDraft; summary: string }
  | { kind: "next" }
  | { kind: "reply"; text: string }
  | { kind: "none"; why: string };

const words = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const accepts = new Set([
  "accept",
  "accept it",
  "approve",
  "approve it",
  "yes",
  "ok",
  "okay",
  "do it",
]);
const declines = new Set(["decline", "decline it", "reject", "reject it", "no", "deny"]);
const nexts = new Set(["next", "skip", "skip it", "later", "next one"]);

export function voiceIntent(
  spoken: string,
  request: Interaction | undefined,
  recommend?: ChiefRecommendation,
): VoiceIntent {
  const text = spoken.trim();
  const said = words(text);
  if (!said) return { kind: "none", why: "Nothing was heard." };
  if (nexts.has(said)) return { kind: "next" };
  if (!request || request.state !== "pending")
    return { kind: "none", why: "Choose a waiting request first." };
  if (request.items.some((item) => item.secret))
    return { kind: "none", why: "Private answers are typed in the request itself." };
  if (accepts.has(said)) {
    // Zolt's pick when it made one; else approve once, or the request's own recommendation.
    const draft =
      recommendedAnswer(request, recommend) ??
      (request.type === "approval" && requestChoices(request).has("allow_once")
        ? { action: "accept" as const, choice: "allow_once" }
        : recommendedAnswer(request));
    return draft
      ? { kind: "answer", draft, summary: "Accepted" }
      : { kind: "none", why: "There is no answer to accept; say your reply instead." };
  }
  if (declines.has(said))
    return request.type === "question" || request.type === "form"
      ? { kind: "answer", draft: { action: "cancel" }, summary: "Skipped" }
      : { kind: "answer", draft: { action: "decline" }, summary: "Declined" };
  return { kind: "reply", text };
}

/** The answers a spoken reply can become, for the confirmation buttons. */
export function replyChoices(
  request: Interaction,
  text: string,
): { label: string; draft: AnswerDraft }[] {
  if (request.type === "approval" || request.type === "plan") {
    const once = requestChoices(request).has("allow_once");
    return [
      {
        label: "Approve with this note",
        draft: { action: "accept", ...(once ? { choice: "allow_once" } : {}), feedback: text },
      },
      { label: "Decline with this note", draft: { action: "decline", feedback: text } },
    ];
  }
  const [item] = request.items;
  if (request.type !== "question" || request.items.length !== 1 || !item) return [];
  const option = item.options?.find(
    (entry) => words(entry.label) === words(text) || words(entry.id) === words(text),
  );
  if (option)
    return [
      {
        label: `Answer "${option.label}"`,
        draft: { action: "accept", answers: { [item.id]: { options: [option.id] } } },
      },
    ];
  if (item.options?.length && !item.allowOther) return [];
  return [
    {
      label: "Send this answer",
      draft: { action: "accept", answers: { [item.id]: { other: text } } },
    },
  ];
}
