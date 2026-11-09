import { type Interaction, InteractionSchema, parse } from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  inboxRow,
  itemText,
  type Letter,
  lettersFrom,
  mailboxLabels,
  replyQuestions,
  snoozeTimes,
} from "../../data/inbox";
import { ago, profileName, text } from "../../data/view";
import { useAction } from "../../state/actions";
import { useSnapshot } from "../../state/link";
import { touch, useTheme } from "../../theme";
import { ChatOutcome, ChatWaiting } from "../../ui/ChatOutcome";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { InteractionCard } from "../../ui/interactions/InteractionCard";
import { Button, Card, Chip, Txt } from "../../ui/kit";
import { Markdown } from "../../ui/Markdown";

/** One conversation as letters: the newest from the agent open, the rest folded. */
export default function InboxThread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const { run, busy } = useAction();
  const row = inboxRow(snapshot, id);
  const name = profileName(snapshot, row?.thread.agentId) || "Agent";
  const items = useMemo(
    () => (snapshot.entities.item ?? []).filter((item) => item.threadId === id),
    [snapshot.entities.item, id],
  );
  const letters = useMemo(() => lettersFrom(items), [items]);
  const newest = [...letters].reverse().find((letter) => letter.from === "agent")?.id;
  const [open, setOpen] = useState(new Set<string>());
  const questions = replyQuestions(snapshot.entities.interaction, id);
  const asked = new Set(questions.map((question) => text(question.interaction.id)));
  const cards: Interaction[] = [];
  for (const request of snapshot.entities.interaction ?? []) {
    if (request.threadId !== id || request.state !== "pending" || asked.has(text(request.id)))
      continue;
    try {
      cards.push(parse(InteractionSchema, request));
    } catch {}
  }
  // Opening the conversation reads it, here and on every other device.
  const ended = row?.lastTurnEndedAt;
  const marked = useRef("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per finished turn
  useEffect(() => {
    if (!row?.unread || !ended || marked.current === `${id}:${ended}`) return;
    marked.current = `${id}:${ended}`;
    void run(
      "thread.markRead",
      { id, at: ended },
      { key: `read:${id}:${ended}`, quiet: true },
    ).catch(() => undefined);
  }, [id, ended, row?.unread]);
  if (!row)
    return (
      <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
        <BackBar label="Inbox" />
        <Txt tone="muted" style={styles.pad}>
          This conversation is gone.
        </Txt>
      </View>
    );
  const thread = row.thread;
  const more = () =>
    Alert.alert(thread.title || "Conversation", undefined, [
      ...snoozeTimes().map((time) => ({
        text: `Later: ${time.label}`,
        onPress: () =>
          void run("thread.snooze", { id, until: time.at.toISOString() }, { key: `snooze:${id}` }),
      })),
      { text: "Mark unread", onPress: () => void run("thread.markUnread", { id }) },
      { text: "Open as chat", onPress: () => router.push(`/chat/${id}`) },
      { text: "Cancel", style: "cancel" as const },
    ]);
  const settle = async () => {
    if (await run("thread.settle", { id })) router.back();
  };
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
      <BackBar
        label="Inbox"
        right={<Button label="More" kind="plain" onPress={more} disabled={busy} />}
      />
      <ScrollView contentContainerStyle={styles.body}>
        <OfflineBanner />
        <View style={styles.head}>
          <Txt v="cardTitle" accessibilityRole="header">
            {thread.title || "Conversation"}
          </Txt>
          <Txt v="meta" tone="muted">
            {[
              name,
              row.mailbox ? mailboxLabels[row.mailbox] : "",
              thread.archiveWhenIdle ? "Settles when done" : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </Txt>
        </View>
        <Button
          label="Results"
          onPress={() => router.push(`/chat/results?id=${encodeURIComponent(id)}`)}
        />
        <ChatWaiting threadId={id} />
        {letters.length ? null : <Txt tone="muted">Nothing has been said yet.</Txt>}
        {letters.map((letter) =>
          letter.id === newest || open.has(letter.id) || letter.queued ? (
            <LetterCard key={letter.id} letter={letter} name={name}>
              {letter.id === newest && questions.length ? (
                <View style={styles.questions} accessibilityLabel="Questions">
                  {questions.map((question) => (
                    <View
                      key={question.n}
                      style={[styles.question, { backgroundColor: c["attention-soft"] }]}
                    >
                      <Txt v="bodyMedium" tone="attention">{`Q${question.n}`}</Txt>
                      <Txt style={styles.flex}>{text(question.item.prompt)}</Txt>
                    </View>
                  ))}
                </View>
              ) : null}
            </LetterCard>
          ) : (
            <Pressable
              key={letter.id}
              accessibilityRole="button"
              accessibilityLabel={`${letter.from === "you" ? "You" : name}: ${letter.summary}`}
              accessibilityHint="Opens this letter"
              onPress={() => setOpen((previous) => new Set(previous).add(letter.id))}
              style={[styles.folded, { borderColor: c.border }]}
            >
              <Txt v="bodyMedium">{letter.from === "you" ? "You" : name}</Txt>
              <Txt v="meta" tone="muted" lines={1} style={styles.flex}>
                {letter.summary}
              </Txt>
              <Txt v="meta" tone="muted">
                {ago(letter.at)}
              </Txt>
            </Pressable>
          ),
        )}
        {cards.map((request) => (
          <InteractionCard key={`${request.id}:${request.version}`} request={request} who={name} />
        ))}
        <ChatOutcome threadId={id} />
      </ScrollView>
      <View
        style={[
          styles.bar,
          {
            borderTopColor: c.border,
            backgroundColor: c["bg-page"],
            paddingBottom: insets.bottom + 8,
          },
        ]}
      >
        <Button
          label={
            questions.length
              ? `Reply to ${questions.length} ${questions.length === 1 ? "question" : "questions"}`
              : "Reply"
          }
          kind="primary"
          style={styles.flex}
          onPress={() => router.push(`/inbox/reply?id=${encodeURIComponent(id)}`)}
        />
        {row.mailbox === "settled" ? (
          <Button
            label="Move to Inbox"
            disabled={busy}
            onPress={() => void run("thread.unarchive", { id })}
          />
        ) : (
          <Button
            label={row.mailbox === "working" ? "Settle when done" : "Settle"}
            disabled={busy || Boolean(thread.archiveWhenIdle)}
            onPress={() => void settle()}
          />
        )}
      </View>
    </View>
  );
}

function LetterCard({
  letter,
  name,
  children,
}: {
  letter: Letter;
  name: string;
  children?: React.ReactNode;
}) {
  const said = letter.items.filter((item) => item.kind === "user" || item.kind === "message");
  return (
    <Card label={`${letter.from === "you" ? "You" : name}, ${ago(letter.at)}`}>
      <View style={styles.letterHead}>
        <Txt v="bodyMedium">{letter.from === "you" ? "You" : name}</Txt>
        <Txt v="meta" tone="muted">
          {ago(letter.at)}
        </Txt>
        {letter.queued ? <Chip label="Queued" tone="accent" /> : null}
      </View>
      {said.map((item) => (
        <Markdown key={text(item.id)} value={itemText(item)} />
      ))}
      {letter.tools ? (
        <Txt v="meta" tone="muted">
          {`${letter.tools} tool ${letter.tools === 1 ? "call" : "calls"} · open as chat to see them`}
        </Txt>
      ) : null}
      {children}
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  pad: { padding: 16 },
  body: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  head: { gap: 2, marginBottom: 4 },
  folded: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: touch,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 12,
  },
  letterHead: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  questions: { gap: 6, marginTop: 6 },
  question: { flexDirection: "row", gap: 8, padding: 10, borderRadius: 8 },
  bar: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
});
