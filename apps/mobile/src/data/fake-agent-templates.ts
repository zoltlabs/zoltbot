// A1 in sample mode: a few templates, and creating a profile from one.
import type { Row } from "./transport";

const templates = [
  {
    id: "frontend-engineer",
    name: "Frontend engineer",
    role: "Builds and fixes web interfaces",
    instructions: "You build and fix the parts of the product people see and touch.",
    skills: [],
    connections: ["github"],
    modelTier: "balanced",
    managerFriendly: true,
  },
  {
    id: "code-reviewer",
    name: "Code reviewer",
    role: "Reviews changes for bugs and risks",
    instructions: "You review code changes before they merge.",
    skills: [],
    connections: ["github"],
    modelTier: "best",
    managerFriendly: true,
  },
  {
    id: "executive-assistant",
    name: "Executive assistant",
    role: "Keeps your calendar, inbox and errands moving",
    instructions: "You keep the owner's day organized.",
    skills: [],
    connections: ["gmail"],
    modelTier: "balanced",
    managerFriendly: false,
  },
];

/** Answers template methods, or undefined for any other method. */
export function answerAgentTemplates(method: string, p: Row, create: (row: Row) => Row): unknown {
  if (method === "agent.templates.list") return { items: structuredClone(templates) };
  if (method === "agent.create") {
    const value = p.value as Row;
    if (value.templateId !== undefined && !templates.some((row) => row.id === value.templateId))
      throw new Error("agent_template_unavailable");
    return create(value);
  }
  return undefined;
}
