// C4: pinned messages, over IPC.

export const PIN_CHANNELS = {
  pinsSet: "pins:set",
} as const;

/** A pinned message as the strip shows it. */
export interface PinnedMessage {
  messageId: string;
  author: "user" | "assistant" | "agent";
  text: string;
}

export interface PinsDesktopApi {
  set: (input: { botId: string; messageId: string; pinned: boolean }) => Promise<void>;
}
