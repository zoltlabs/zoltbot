// C4 and C5: Pin, Unpin, Hide and Show for the chat's messages.
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
}

export function messageMarks(threadId: string, pinnedIds: Set<string>, run: Run): MarkActions {
  const call = (method: string, row: TranscriptRow, done: string, failed: string) =>
    void run(method, { threadId, itemId: row.id }, { quiet: true }).then(
      (sent) => sent !== undefined && AccessibilityInfo.announceForAccessibility(done),
      (error: unknown) =>
        Alert.alert(
          error instanceof Error && error.message === "pin_limit"
            ? "This chat has 50 pins. Unpin one first."
            : failed,
        ),
    );
  return {
    isPinned: (rowId) => pinnedIds.has(rowId),
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
