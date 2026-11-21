// B1–B3: the agent's own browser, run by the daemon.

/** B1: a profile an agent keeps, so it stays signed in between tasks. */
export interface AgentBrowserProfile {
  id: string;
  agentId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

export const AGENT_BROWSER_CHANNELS = {
  agentBrowserProfile: "agent-browser:profile",
  agentBrowserClearProfile: "agent-browser:clear-profile",
} as const;

export interface AgentBrowserDesktopApi {
  /** The agent's kept profile, or null. */
  profile: (input: { agentId: string }) => Promise<AgentBrowserProfile | null>;
  /** Signs the agent out of every site. The caller has already asked the owner. */
  clearProfile: (input: { agentId: string }) => Promise<void>;
}
