import type { Interaction } from "@zoltbot/protocol";
import { webResultUrl } from "../chat/tools/result-data.js";
import { linkParts } from "../chat/tools/tool-data.js";
import type { AnswerDraft } from "./actions.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export type Choices = Map<string, { id: string; label?: string | undefined }>;
export function requestChoices(request: Interaction): Choices {
  const result: Choices = new Map();
  for (const item of request.items)
    for (const choice of item.choices ?? [])
      if (!result.has(choice.id))
        result.set(choice.id, {
          id: choice.id,
          ...("label" in choice && choice.label ? { label: choice.label } : {}),
        });
  return result;
}
export const withFeedback = (feedback: string) => (feedback.trim() ? { feedback } : {});

/**
 * The plan's Enter and primary answer: approve and keep reviewing each edit. Auto-accepting edits
 * widens permission, so it is only ever chosen through its own button.
 */
export function planApproval(choices: Choices, feedback: string): AnswerDraft {
  if (choices.has("allow_once"))
    return { action: "accept", choice: "allow_once", ...withFeedback(feedback) };
  return { action: "accept", ...withFeedback(feedback) };
}
/** A form with no fields: the request is a message or a link to open (URL mode elicitation). */
export function linkOnlyForm(request: Interaction): boolean {
  return request.items.every((item) => {
    if (item.schema === undefined) return true;
    const schema = record(item.schema);
    return schema.type === "object" && Object.keys(record(schema.properties)).length === 0;
  });
}
export function formLinks(request: Interaction): string[] {
  const texts = [request.context?.markdown ?? "", ...request.items.map((item) => item.prompt)];
  const links = texts.flatMap((value) => linkParts(value).flatMap((part) => part.href ?? []));
  return [...new Set(links.flatMap((href) => webResultUrl(href) ?? []))].slice(0, 3);
}
export function formHost(href: string) {
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
}

export type Reversibility = "read" | "undoable" | "permanent" | "external";
const external =
  /^\s*(git\s+push|gh\s|npm\s+publish|pnpm\s+publish|yarn\s+publish|curl\s|wget\s|ssh\s|scp\s|rsync\s|docker\s+push|vercel\b|wrangler\s+deploy|firebase\s+deploy)/;
/**
 * How easily an approved action can be taken back, from what the provider reported about the tool.
 * Unknown tools get no label rather than a guess.
 */
export function reversibility(
  request: Interaction,
): { level: Reversibility; label: string; detail: string } | undefined {
  const context = request.context;
  if (!context) return undefined;
  const command = context.command?.trim() ?? "";
  if (context.network || context.toolKind === "fetch" || (command && external.test(command)))
    return {
      level: "external",
      label: "Leaves this computer",
      detail: context.network?.host
        ? `Reaches ${context.network.host}. What it sends can't be taken back.`
        : "Reaches another service. What it sends can't be taken back.",
    };
  switch (context.toolKind) {
    case "read":
    case "search":
    case "think":
      return { level: "read", label: "Read only", detail: "Looks without changing anything." };
    case "edit":
    case "move":
      return {
        level: "undoable",
        label: "Can be undone",
        detail: "Changes files. Rewind or git can restore them.",
      };
    case "delete":
      return {
        level: "permanent",
        label: "Hard to undo",
        detail: "Deletes files. Only Rewind or git can bring them back.",
      };
    case "execute":
      return {
        level: "permanent",
        label: "Can't be undone",
        detail: "Runs a command. Its effects aren't tracked, so Rewind can't reverse them.",
      };
    default:
      return undefined;
  }
}
