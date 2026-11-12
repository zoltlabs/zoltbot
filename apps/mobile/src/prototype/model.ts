import type { Interaction } from "@zoltbot/protocol";

export type State = "working" | "needs_you" | "review" | "idle" | "later" | "problem";
export const marks = {
  working: { shape: "⬡", label: "Working", tone: "accent-text" },
  needs_you: { shape: "◆", label: "Needs you", tone: "attention" },
  review: { shape: "⚑", label: "Done, unread", tone: "ok" },
  idle: { shape: "▬", label: "Idle", tone: "text-secondary" },
  later: { shape: "▬", label: "Later", tone: "text-secondary" },
  problem: { shape: "▲", label: "Warning", tone: "danger" },
} as const;
export const providers = ["codex", "claude", "gemini", "cursor"] as const;
export interface Agent {
  id: string;
  title: string;
  provider: (typeof providers)[number];
  state: State;
  activity: string;
  result: string;
  messages: string[];
  request?: Interaction;
}
export interface Initiative {
  id: string;
  name: string;
  goal: string;
  done: number;
  total: number;
  changes: string;
  prs: string[];
  checks: string[];
  agents: Agent[];
}
export interface Project {
  name: string;
  spend: number;
  initiatives: Initiative[];
}
export const queue = (project: Project) =>
  project.initiatives
    .flatMap((i) =>
      i.agents.flatMap((agent) =>
        agent.request ? [{ agent, initiative: i, request: agent.request }] : [],
      ),
    )
    .sort(
      (a, b) =>
        a.request.createdAt.localeCompare(b.request.createdAt) ||
        a.request.id.localeCompare(b.request.id),
    );
export const waiting = (i: Initiative) => i.agents.filter((a) => a.request).length;
export const sorted = (project: Project) =>
  [...project.initiatives].sort((a, b) => {
    const oldest = (i: Initiative) =>
      Math.min(...i.agents.flatMap((a) => (a.request ? [Date.parse(a.request.createdAt)] : [])));
    return (
      Number(waiting(b) > 0) - Number(waiting(a) > 0) ||
      oldest(a) - oldest(b) ||
      a.id.localeCompare(b.id)
    );
  });
export const waited = (request: Interaction, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(request.createdAt)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};
export const columns = (fontScale: number, layout: "board" | "stacked") =>
  fontScale > 1.2 || layout === "stacked" ? 1 : 2;
export function updateAgent(project: Project, id: string, update: (a: Agent) => Agent): Project {
  return {
    ...project,
    initiatives: project.initiatives.map((i) => ({
      ...i,
      agents: i.agents.map((a) => (a.id === id ? update(a) : a)),
    })),
  };
}
export function answerRequest(project: Project, id: string, summary: string): Project {
  const entry = queue(project).find((e) => e.request.id === id);
  if (!entry) return project;
  return updateAgent(project, entry.agent.id, (a) => ({
    ...a,
    request: undefined,
    state: "working",
    activity: "Applying your answer",
    messages: [...a.messages, summary],
  }));
}

export const widens = (choice: string | undefined) =>
  ["allow_session", "allow_accept_edits", "allow_rule", "reject_rule"].includes(choice ?? "");
