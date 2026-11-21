// P5: touch and hold a message for its actions. The same menu opens from the Message actions
// button, and VoiceOver gets each item as an action, plus Show time for the left drag.
import { MESSAGE_REACTION_EMOJI } from "@zoltbot/protocol";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { AccessibilityInfo, Alert, Share } from "react-native";
import { type MenuKey, messageMenu, messageTime } from "../data/message-menu";
import { pinnable } from "../data/pins";
import type { TranscriptRow } from "../data/view";
import type { MarkActions } from "./message-marks";
import { readAloud, readableReply, stopReading, useReading } from "./read-aloud";
import { pick } from "./SessionControls";

/** C1: what the owner can do with a queued message. Move up / down only where there is room. */
export interface QueueActions {
  sendNow: () => void;
  remove: () => void;
  moveUp?: () => void;
  moveDown?: () => void;
}

export interface MessageMenu {
  open(): void;
  time: string;
  a11y: {
    accessibilityActions: { name: string; label: string }[];
    onAccessibilityAction: (event: { nativeEvent: { actionName: string } }) => void;
  };
}

const SHOW_TIME = "Show time";

export function useMessageMenu({
  row,
  words,
  marks,
  threadId,
  edit,
  forward,
  queue,
}: {
  row: TranscriptRow;
  /** What Copy and Share take: your words without the quote you replied to. */
  words: string;
  marks?: MarkActions | undefined;
  threadId?: string | undefined;
  edit?: { kind: "queued" | "sent"; run: () => void } | undefined;
  forward?: (() => void) | undefined;
  queue?: QueueActions | undefined;
}): MessageMenu {
  const reading = useReading((state) => state.id === row.id);
  const pinned = marks?.isPinned(row.id) ?? false;
  const markable = !!marks && pinnable(row);
  const items = messageMenu({
    mine: row.kind === "user",
    hasText: !!words.trim(),
    markable,
    pinned,
    readable: readableReply(row),
    reading,
    branch: !!marks && !!threadId && !!row.branchTurnId,
    ...(edit ? { edit: edit.kind } : {}),
    forward: !!forward,
    ...(queue ? { queue: { moveUp: !!queue.moveUp, moveDown: !!queue.moveDown } } : {}),
  });
  const time = messageTime(row.at);
  const actions: Record<MenuKey, () => void> = {
    reply: () => marks?.reply?.(row),
    copy: () =>
      void Clipboard.setStringAsync(words).then(
        () => AccessibilityInfo.announceForAccessibility("Copied"),
        () => Alert.alert("Couldn’t copy the message. Try again."),
      ),
    pin: () => marks?.set(row, true),
    unpin: () => marks?.set(row, false),
    read: () => readAloud(row),
    stopReading,
    branch: () =>
      router.push(
        `/chat/fork?id=${encodeURIComponent(threadId ?? "")}&turnId=${encodeURIComponent(row.branchTurnId ?? "")}`,
      ),
    hide: () => marks?.hide(row, true),
    react: () => {
      const current = row.reactions?.owner;
      const labels = [...MESSAGE_REACTION_EMOJI, ...(current ? [`Remove ${current}`] : [])];
      pick("React", undefined, labels, (index) =>
        marks?.react(row, index < MESSAGE_REACTION_EMOJI.length ? (labels[index] ?? null) : null),
      );
    },
    edit: () => edit?.run(),
    forward: () => forward?.(),
    share: () =>
      void Share.share({ message: words }).catch(() =>
        Alert.alert("Couldn’t open sharing. Try again."),
      ),
    sendNow: () => queue?.sendNow(),
    moveUp: () => queue?.moveUp?.(),
    moveDown: () => queue?.moveDown?.(),
    remove: () => queue?.remove(),
  };
  const byLabel = new Map(items.map((item) => [item.label, actions[item.key]]));
  return {
    time,
    open() {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      pick(
        "Message",
        undefined,
        items.map((item) => item.label),
        (index) => {
          const chosen = items[index];
          if (chosen) actions[chosen.key]();
        },
      );
    },
    a11y: {
      accessibilityActions: [
        ...items.map((item) => ({ name: item.label, label: item.label })),
        ...(time ? [{ name: SHOW_TIME, label: SHOW_TIME }] : []),
      ],
      onAccessibilityAction: (event) => {
        const name = event.nativeEvent.actionName;
        if (name === SHOW_TIME) AccessibilityInfo.announceForAccessibility(time);
        else byLabel.get(name)?.();
      },
    },
  };
}
