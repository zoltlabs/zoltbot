import { compareQuote } from "@zoltbot/protocol";
import type { Row } from "../chat/types.js";
export type CompareLayout = "columns" | "tabs" | "stacked";
export function layoutFor(width: number, members: number, preferred: CompareLayout): CompareLayout {
  return preferred === "columns" && (width < 1100 || (members === 4 && width < 1440))
    ? "tabs"
    : preferred;
}
export function scrollFraction(top: number, height: number, viewport: number) {
  return Math.max(0, Math.min(1, top / Math.max(1, height - viewport)));
}
export function scrollPosition(fraction: number, height: number, viewport: number) {
  return Math.max(0, height - viewport) * Math.max(0, Math.min(1, fraction));
}
export function readOnlyReason(profile: Row, definitions: Row[], online: boolean) {
  const definition = definitions.find((r) => r.id === profile.definitionId);
  if ((definition?.staticCapabilities as Row | undefined)?.readOnly !== true)
    return "Can't run read-only";
  if (!online) return "Connect to the daemon to compare";
  return "";
}
export const quotedAnswer = compareQuote;
export function answerDraft(
  action: "merge" | "critique",
  answers: { name: string; answer: string }[],
) {
  return `${action === "merge" ? "Merge these answers into one useful answer." : "Critique the other answers. Explain strengths, gaps and disagreements."}\n\n${answers.map((a) => quotedAnswer(a.name, a.answer)).join("\n\n")}`;
}
export function compareAnswers(entities: Record<string, Row[]>, id: string) {
  return (entities.compareMember ?? [])
    .filter((r) => r.compareId === id)
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((member) => {
      const threadId = String(member.threadId),
        thread = entities.thread?.find((r) => r.id === threadId),
        profile = entities.agent?.find((r) => r.id === thread?.agentId);
      const messages = (entities.item ?? [])
        .filter(
          (r) =>
            r.threadId === threadId &&
            r.kind === "message" &&
            !(r.body as Row | undefined)?.parentItemId,
        )
        .sort((a, b) => Number(a.seq) - Number(b.seq));
      const item = messages.filter((r) => r.phase === "final").at(-1) ?? messages.at(-1);
      return {
        threadId,
        profileId: String(profile?.id ?? ""),
        name: String(profile?.name ?? "Profile"),
        answer: String((item?.body as Row | undefined)?.text ?? "(No answer available.)"),
      };
    });
}
