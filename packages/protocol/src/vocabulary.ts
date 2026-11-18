/**
 * User-facing words for the organization tree, kept in one place so desktop and mobile say
 * the same thing and the words can change without touching entity kinds or RPC names.
 *
 * - workspace: the repository or shared code context (entity kind `project`).
 * - team: a project within a repository (entity kind `subproject`).
 * - manager: a team's or workspace's one persistent lead agent (thread kind `manager`).
 * - chat: a conversation inside a team or workspace (thread kind `side` or `main`).
 * - profile: the saved preset a manager or chat runs on (entity kind `agent`).
 */
function term(one: string, many: string) {
  const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  return { one, many, One: capital(one), Many: capital(many) } as const;
}

export const terms = {
  workspace: term("repo", "repos"),
  team: term("project", "projects"),
  manager: term("manager", "managers"),
  chat: term("chat", "chats"),
  profile: term("profile", "profiles"),
  task: term("task", "tasks"),
  routine: term("routine", "routines"),
} as const;

export type Term = keyof typeof terms;

/** "Repo" for the top level, "Project" for any level inside it. */
export function scopeNoun(type: "project" | "subproject") {
  return type === "project" ? terms.workspace : terms.team;
}
