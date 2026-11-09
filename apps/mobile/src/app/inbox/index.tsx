import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  inbox,
  type Mailbox,
  mailboxes,
  mailboxHints,
  mailboxLabels,
  pendingLine,
  snoozeTimes,
} from "../../data/inbox";
import { ago, place, profileName, text } from "../../data/view";
import { useAction } from "../../state/actions";
import { useSnapshot } from "../../state/link";
import { useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Avatar, Chip, Group, Txt } from "../../ui/kit";

/** The Inbox: every conversation filed by what it needs from you, read like mail. */
export default function Inbox() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const { run, busy } = useAction();
  const [box, setBox] = useState<Mailbox>("needs_you");
  const { items, counts } = useMemo(() => inbox(snapshot), [snapshot]);
  const rows = items.filter((row) => row.mailbox === box);
  // Long-press is the phone's version of the Mac's e, h and u keys.
  const actions = (id: string, title: string, settled: boolean) =>
    Alert.alert(title || "Conversation", undefined, [
      ...snoozeTimes().map((time) => ({
        text: `Later: ${time.label}`,
        onPress: () =>
          void run("thread.snooze", { id, until: time.at.toISOString() }, { key: `snooze:${id}` }),
      })),
      settled
        ? { text: "Move to Inbox", onPress: () => void run("thread.unarchive", { id }) }
        : { text: "Settle", onPress: () => void run("thread.settle", { id }) },
      { text: "Mark unread", onPress: () => void run("thread.markUnread", { id }) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
      <BackBar label="Home" />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Txt v="largeTitle" accessibilityRole="header">
          Inbox
        </Txt>
        <OfflineBanner />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.boxes}
          accessibilityRole="tablist"
          accessibilityLabel="Mailboxes"
        >
          {mailboxes.map((id) => {
            const on = id === box;
            return (
              <Pressable
                key={id}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${mailboxLabels[id]}${counts[id] ? `, ${counts[id]}` : ""}`}
                onPress={() => setBox(id)}
                style={[
                  styles.box,
                  { borderColor: c.border, backgroundColor: on ? c["bg-raised"] : "transparent" },
                ]}
              >
                <Txt v="bodyMedium" tone={on ? "text" : "secondary"}>
                  {mailboxLabels[id]}
                  {counts[id] ? `  ${counts[id]}` : ""}
                </Txt>
              </Pressable>
            );
          })}
        </ScrollView>
        <Txt v="meta" tone="muted">
          {mailboxHints[box]}
        </Txt>
        {rows.length ? (
          <Group>
            {rows.map((row, index) => {
              const thread = row.thread;
              const meta = [
                profileName(snapshot, thread.agentId),
                place(snapshot, thread),
                pendingLine(row.pending),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <Pressable
                  key={thread.id}
                  accessibilityRole="button"
                  accessibilityLabel={[
                    thread.title || "Conversation",
                    row.unread ? "unread" : "",
                    meta,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  accessibilityHint="Long press for Later, Settle and Mark unread"
                  onPress={() => router.push(`/inbox/${thread.id}`)}
                  onLongPress={() =>
                    actions(thread.id, thread.title ?? "", row.mailbox === "settled")
                  }
                  disabled={busy}
                  style={({ pressed }) => [
                    styles.row,
                    index < rows.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: c.border,
                    },
                    pressed && { backgroundColor: c["bg-active"] },
                  ]}
                >
                  <Avatar id={text(thread.agentId)} />
                  <View style={styles.rowText}>
                    <View style={styles.rowHead}>
                      <Txt v="bodyMedium" lines={1} style={styles.flex}>
                        {thread.title || "Conversation"}
                      </Txt>
                      <Txt v="meta" tone="muted">
                        {ago(row.lastTurnEndedAt ?? thread.lastActivityAt)}
                      </Txt>
                    </View>
                    <Txt v="meta" tone="muted" lines={1}>
                      {meta}
                    </Txt>
                    {row.preview ? (
                      <Txt v="meta" tone="secondary" lines={2}>
                        {row.preview}
                      </Txt>
                    ) : null}
                    {row.mailbox === "needs_you" || row.unread ? (
                      <View style={styles.chips}>
                        {row.mailbox === "needs_you" ? (
                          <Chip label="Needs you" tone="attention" dot />
                        ) : (
                          <Chip label="New" tone="accent" dot />
                        )}
                      </View>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </Group>
        ) : (
          <Txt tone="muted" style={styles.empty}>
            {box === "needs_you" ? "Nothing needs you." : `Nothing in ${mailboxLabels[box]}.`}
          </Txt>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  boxes: { gap: 6, paddingVertical: 2 },
  box: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  empty: { marginHorizontal: 4 },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowHead: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  chips: { flexDirection: "row", gap: 6, marginTop: 4 },
  flex: { flex: 1 },
});
