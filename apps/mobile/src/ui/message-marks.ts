// C4, C5, C6 and C8: Reply, Pin, Unpin, Hide, Show and React for the chat's messages.
import { AccessibilityInfo, Alert } from "react-native";
import type { TranscriptRow } from "../data/view";
import { usePrefs } from "../state/prefs";

type Run = (
  method: string,
  params: unknown,
  options?: { key?: string; quiet?: boolean },
) => Promise<unknown>;

export interface MarkActions {
  isPinned: (rowId: string) => boolean;
  set: (row: TranscriptRow, pinned: boolean) => void;
  hide: (row: TranscriptRow, hidden: boolean) => void;
  /** The owner's reaction; null clears it. */
  react: (row: TranscriptRow, emoji: string | null) => void;
  /** Quotes the message in the composer. */
  reply?: (row: TranscriptRow) => void;
}

export function messageMarks(
  threadId: string,
  pinnedIds: Set<string>,
  run: Run,
  reply?: (row: TranscriptRow) => void,
): MarkActions {
  const call = (
    method: string,
    row: TranscriptRow,
    done: string,
    failed: string,
    extra: Record<string, unknown> = {},
  ) =>
    void run(method, { threadId, itemId: row.id, ...extra }, { quiet: true }).then(
      (sent) => sent !== undefined && AccessibilityInfo.announceForAccessibility(done),
      (error: unknown) =>
        Alert.alert(
          error instanceof Error && error.message === "pin_limit"
            ? "This chat has 50 pins. Unpin one first."
            : failed,
        ),
    );
  return {
    ...(reply ? { reply } : {}),
    isPinned: (rowId) => pinnedIds.has(rowId),
    react: (row, emoji) =>
      call(
        "message.react",
        row,
        emoji ? `Reacted ${emoji}` : "Reaction removed",
        "Couldn’t react to the message. Try again.",
        { emoji },
      ),
    set: (row, on) =>
      on
        ? call("message.pin", row, "Pinned", "Couldn’t pin the message. Try again.")
        : call("message.unpin", row, "Unpinned", "Couldn’t unpin the message. Try again."),
    hide: (row, hidden) => {
      if (!hidden)
        return call(
          "message.unhide",
          row,
          "Message shown",
          "Couldn’t show the message. Try again.",
        );
      const hide = () =>
        call("message.hide", row, "Message hidden", "Couldn’t hide the message. Try again.");
      if (usePrefs.getState().hideConfirmed) return hide();
      Alert.alert("Hide this message?", "The agent still remembers it.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Hide",
          onPress: () => {
            usePrefs.getState().set({ hideConfirmed: true });
            hide();
          },
        },
      ]);
    },
  };
}
