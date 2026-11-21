// B1–B3: the agent's own browser, run by the daemon.
import type { AgentBrowserInput } from "./agent-browser-input";

export type { AgentBrowserInput };

/** B1: a profile an agent keeps, so it stays signed in between tasks. */
export interface AgentBrowserProfile {
  id: string;
  agentId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string;
}

/** B2: one picture of the agent's browser. Frames are never stored. */
export interface AgentBrowserFrame {
  threadId: string;
  /** Base64 JPEG. */
  data: string;
  width: number;
  height: number;
  url: string;
  /** Where the last press landed, in page pixels. */
  pointer?: { x: number; y: number };
}

export interface AgentBrowserViewState {
  running: boolean;
  url: string | null;
  /** B3: the owner controls the browser and the agent waits. */
  control: boolean;
}

export const AGENT_BROWSER_CHANNELS = {
  agentBrowserProfile: "agent-browser:profile",
  agentBrowserClearProfile: "agent-browser:clear-profile",
  agentBrowserView: "agent-browser:view",
  agentBrowserFrame: "agent-browser:frame",
  agentBrowserTakeover: "agent-browser:takeover",
  agentBrowserInput: "agent-browser:input",
} as const;

/** How often an open panel renews its view; the daemon drops a viewer after 20 seconds. */
export const AGENT_BROWSER_RENEW_MS = 5_000;

export interface AgentBrowserDesktopApi {
  /** The agent's kept profile, or null. */
  profile: (input: { agentId: string }) => Promise<AgentBrowserProfile | null>;
  /** Signs the agent out of every site. The caller has already asked the owner. */
  clearProfile: (input: { agentId: string }) => Promise<void>;
  /** Opens, renews or closes this window's view of a chat's browser. */
  view: (input: { threadId: string; open: boolean }) => Promise<AgentBrowserViewState>;
  /** B3: takes control of the chat's browser (the agent waits) or hands it back. */
  takeover: (input: {
    threadId: string;
    control: boolean;
  }) => Promise<{ control: boolean; url: string | null }>;
  /** B3: one mouse or key event while in control. Never logged. */
  input: (input: { threadId: string; event: AgentBrowserInput }) => Promise<void>;
  /** Frames for the chats this window views. */
  onFrame: (listener: (frame: AgentBrowserFrame) => void) => () => void;
}
