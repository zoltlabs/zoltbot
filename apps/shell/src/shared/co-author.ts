// A4: whether a chat's project names agents in their commits, over IPC.

export const CO_AUTHOR_CHANNELS = {
  coAuthorGet: "co-author:get",
  coAuthorSet: "co-author:set",
} as const;

export interface ProjectCoAuthor {
  projectId: string;
  /** Agents' commits get a Co-Authored-By line. */
  enabled: boolean;
}

export interface CoAuthorDesktopApi {
  /** The chat's project setting, or null when the chat has no project with a repository. */
  get: (botId: string) => Promise<ProjectCoAuthor | null>;
  set: (input: ProjectCoAuthor) => Promise<void>;
}
