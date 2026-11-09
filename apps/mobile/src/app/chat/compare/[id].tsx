import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pendingFor } from "../../../data/interactions";
import { profileName, runningTurn, text, transcript } from "../../../data/view";
import { useAction } from "../../../state/actions";
import { useClient, useSnapshot } from "../../../state/link";
import { sans, touch, useTheme } from "../../../theme";
import { BackBar, OfflineBanner } from "../../../ui/chrome";
import { InteractionCard } from "../../../ui/interactions/InteractionCard";
import { Button, Chip, Txt } from "../../../ui/kit";
import { Message } from "../../../ui/Transcript";

export default function Compare() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const snapshot = useSnapshot(),
    e = snapshot.entities;
  const group = e.compare?.find((r) => r.id === id);
  const members = (e.compareMember ?? [])
    .filter((r) => r.compareId === id)
    .sort((a, b) => Number(a.position) - Number(b.position));
  const tabs = members.map((m) => ({
    id: text(m.threadId),
    label: profileName(snapshot, e.thread?.find((t) => t.id === m.threadId)?.agentId),
  }));
  if (group?.summaryThreadId) tabs.push({ id: text(group.summaryThreadId), label: "Differences" });
  const [selected, setSelected] = useState(0),
    [draft, setDraft] = useState("");
  const index = Math.min(selected, Math.max(0, tabs.length - 1)),
    tab = tabs[index];
  const selection = useRef({ index, count: tabs.length });
  selection.current = { index, count: tabs.length };
  const swipe = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 40 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderRelease: (_, g) => {
        if (Math.abs(g.dx) > 60)
          setSelected(
            Math.max(
              0,
              Math.min(selection.current.count - 1, selection.current.index + (g.dx < 0 ? 1 : -1)),
            ),
          );
      },
    }),
  ).current;
  const { run, busy } = useAction(),
    online = useClient((s) => s.status === "online");
  const { c } = useTheme(),
    insets = useSafeAreaInsets();
  const disabled = busy || !online || group?.state !== "open";
  const member = members.find((m) => m.threadId === tab?.id),
    turn = tab && runningTurn(snapshot, tab.id);
  const followUp = async () => {
    const message = draft.trim();
    if (!message) return;
    const result = await run("compare.send", { id, input: [{ type: "text", text: message }] });
    if (result) setDraft("");
  };
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}
    >
      <BackBar label="Chats" />
      <View style={styles.heading}>
        <Txt v="cardTitle" accessibilityRole="header">
          {text(group?.title) || "Compare"}
        </Txt>
        <Chip label="Read only" />
        {group && group.state !== "open" ? (
          <Txt tone="muted">
            This compare is {text(group.state)}. Answers and votes are preserved.
          </Txt>
        ) : null}
      </View>
      <ScrollView
        horizontal
        style={styles.tabs}
        contentContainerStyle={styles.tabRow}
        accessibilityRole="tablist"
        accessibilityLabel="Compare answers"
      >
        {tabs.map((t, i) => (
          <Pressable
            key={t.id}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: index === i }}
            onPress={() => setSelected(i)}
            style={[styles.tab, { borderBottomColor: i === index ? c.accent : c.border }]}
          >
            <Txt tone={i === index ? "accent" : "text"}>{t.label}</Txt>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.answer} {...swipe.panHandlers}>
        <ScrollView
          key={tab?.id}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel={`${tab?.label ?? "Compare"} answer`}
        >
          <OfflineBanner />
          {!group ? <Txt tone="muted">This compare is not available on this Mac.</Txt> : null}
          <Txt v="meta" tone="muted">
            {turn ? "Running" : "Saved answer"}
          </Txt>
          {tab
            ? transcript(snapshot, tab.id).map((row) => (
                <Message key={row.id} row={row} threadId={tab.id} />
              ))
            : null}
          {tab && group?.state === "open"
            ? pendingFor(snapshot, tab.id).map((request) => (
                <InteractionCard key={request.id} request={request} who={tab.label} />
              ))
            : null}
          {member ? (
            <View style={styles.actions}>
              <Button
                label={`Continue with ${tab?.label}`}
                kind="primary"
                disabled={disabled}
                onPress={() => {
                  void run("compare.resolve", { id, action: "continue", threadId: tab?.id }).then(
                    (result) => {
                      if (result && tab) router.push(`/chat/${tab.id}`);
                    },
                  );
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Better: ${tab?.label}`}
                accessibilityState={{ selected: member.vote === "better", disabled }}
                disabled={disabled}
                onPress={() => {
                  void run("compare.vote", {
                    id,
                    threadId: tab?.id,
                    vote: member.vote === "better" ? null : "better",
                  });
                }}
                style={[
                  styles.vote,
                  { borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
                ]}
              >
                <Txt>{member.vote === "better" ? "Better ✓" : "Better"}</Txt>
              </Pressable>
            </View>
          ) : null}
          {tab ? (
            <Button label="Open as chat" onPress={() => router.push(`/chat/${tab.id}`)} />
          ) : null}
        </ScrollView>
      </View>
      <View
        style={[
          styles.follow,
          { borderTopColor: c.border, paddingBottom: Math.max(insets.bottom, 12) },
        ]}
      >
        <TextInput
          accessibilityLabel="Follow up with all"
          placeholder="Follow up with all…"
          placeholderTextColor={c["text-dim"]}
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={!disabled}
          style={[
            styles.input,
            { color: c.text, backgroundColor: c["bg-raised"], borderColor: c["border-strong"] },
          ]}
        />
        <Button
          label="Send to all"
          kind="primary"
          disabled={disabled || !draft.trim()}
          onPress={() => {
            void followUp();
          }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  page: { flex: 1 },
  heading: { paddingHorizontal: 16, gap: 8, paddingBottom: 12 },
  tabs: { flexGrow: 0, maxHeight: 64 },
  tabRow: { paddingHorizontal: 12, gap: 8 },
  tab: { minHeight: touch, paddingHorizontal: 16, justifyContent: "center", borderBottomWidth: 2 },
  answer: { flex: 1 },
  body: { padding: 16, gap: 14 },
  actions: { gap: 8 },
  vote: {
    minHeight: touch,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  follow: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  input: {
    fontFamily: sans,
    minHeight: touch,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
  },
});
