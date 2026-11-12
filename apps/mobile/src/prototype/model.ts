import type { Interaction } from "@zoltbot/protocol";

export type State = "working" | "needs_you" | "review" | "idle" | "later" | "problem";
export const statePaths: Record<State, string> = {
  working: "M8 1.5 13.6 4.7v6.6L8 14.5l-5.6-3.2V4.7Z M8 5v6M5 8h6",
  needs_you: "M8 1 14 8l-6 7-6-7Z M8 5v4M8 11v.5",
  review: "M4 14V2h1l8 3.5L5 9",
  idle: "M3 8h10v3H3Z",
  later: "M3 8h10v3H3Z",
  problem: "M8 1.5 15 14H1Z M8 5v4M8 11v1",
};

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
/** Keep an explicit focus stable while simulation changes other squads. */
export function focusedInitiative(project: Project, preferred?: string): Initiative | undefined {
  const chosen = project.initiatives.find((i) => i.id === preferred);
  if (chosen) return chosen;
  return [...sorted(project)].sort((a, b) => waiting(b) - waiting(a))[0];
}
export const unitWidth = (fontScale: number) => (fontScale > 1.4 ? 80 : 44);
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
