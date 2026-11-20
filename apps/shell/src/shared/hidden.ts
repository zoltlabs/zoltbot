// C5: hide a message from the chat, over IPC. The agent still remembers it.

export const HIDDEN_CHANNELS = {
  hiddenSet: "hidden:set",
} as const;

export interface HiddenDesktopApi {
  set: (input: { botId: string; messageId: string; hidden: boolean }) => Promise<void>;
}
