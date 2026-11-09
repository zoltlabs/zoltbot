import type { KnowledgeItem } from "@zoltbot/protocol";

/** Display names for knowledge kinds, in the order the filters list them. */
export const kindLabels: Record<KnowledgeItem["kind"], string> = {
  goal: "Goal",
  decision: "Decision",
  constraint: "Constraint",
  requirement: "Requirement",
  preference: "Preference",
  lesson: "Lesson",
  open_question: "Open question",
  artifact_ref: "Artifact link",
  glossary: "Glossary term",
};
export const kinds = Object.keys(kindLabels) as KnowledgeItem["kind"][];

export const statusLabels: Record<KnowledgeItem["status"], string> = {
  active: "Active",
  stale: "Stale",
  archived: "Archived",
  superseded: "Replaced",
};
export const statuses = Object.keys(statusLabels) as KnowledgeItem["status"][];

/** The label for a kind or status, falling back to the raw value for anything newer. */
export function knowledgeLabel(labels: Record<string, string>, value: string | undefined) {
  return value ? (labels[value] ?? value.replaceAll("_", " ")) : "";
}
