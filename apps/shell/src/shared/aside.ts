// C2: side questions asked while the agent works, over IPC.

export const ASIDE_CHANNELS = {
  asideAsk: "aside:ask",
  asideContinue: "aside:continue",
} as const;

export interface AsideDesktopApi {
  /** Asks in a read-only copy of the chat; the running turn never sees it. */
  ask: (input: { botId: string; text: string }) => Promise<{ threadId: string }>;
  /** Lists the aside as a normal chat, so it can be opened and continued. */
  continue: (input: { threadId: string }) => Promise<void>;
}

/** Marks a message as part of an aside shown inside its chat. */
export interface AsideLink {
  threadId: string;
}
