import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { buildReply, type Draft, emptyDraft, inboxRow, replyQuestions } from "../../data/inbox";
import { text } from "../../data/view";
import { useAction } from "../../state/actions";
import { useClient, useSnapshot } from "../../state/link";
import { useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Field, OptionRow } from "../../ui/interactions/parts";
import { Button, Card, Txt } from "../../ui/kit";

type Row = Record<string, unknown>;

/** One reply: answers to the quoted questions and anything else, sent to the agent as a message. */
export default function Reply() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((s) => s.status === "online");
  const { run, busy } = useAction();
  const row = inboxRow(snapshot, id);
  const questions = replyQuestions(snapshot.entities.interaction, id);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(questions));
  const quoted = questions.filter((question) => draft.quoted.includes(question.n));
  const reply = buildReply(questions, draft);
  const answered = quoted.length - reply.skipped.length;
  const empty = !reply.body.trim();
  const send = async (settle: boolean) => {
    if (empty) return;
    const result = await run("thread.reply", {
      threadId: id,
      body: reply.body,
      answers: reply.answers,
      mode: "queue",
      ...(settle ? { settle: true } : {}),
    });
    if (result) router.back();
  };
  const pick = (n: number, option: string, multi: boolean) =>
    setDraft((previous) => {
      const current = previous.picks[n] ?? [];
      const next = multi
        ? current.includes(option)
          ? current.filter((value) => value !== option)
          : [...current, option]
        : current.includes(option)
          ? []
          : [option];
      return { ...previous, picks: { ...previous.picks, [n]: next } };
    });
  const toggle = (n: number) =>
    setDraft((previous) => ({
      ...previous,
      quoted: previous.quoted.includes(n)
        ? previous.quoted.filter((value) => value !== n)
        : [...previous.quoted, n].sort((a, b) => a - b),
    }));
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}
    >
      <BackBar label="Back" />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <OfflineBanner />
        <Txt v="cardTitle" accessibilityRole="header">
          {`Re: ${row?.thread.title || "Conversation"}`}
        </Txt>
        {questions.map((question) => {
          const on = draft.quoted.includes(question.n);
          const options = Array.isArray(question.item.options)
            ? (question.item.options as Row[])
            : [];
          const multi = question.item.multi === true;
          return (
            <Card key={question.n} label={`Question ${question.n}`}>
              <View style={[styles.quote, { borderLeftColor: c.border }]}>
                <Txt tone="secondary" style={styles.flex}>
                  {`Q${question.n} · ${text(question.item.prompt)}`}
                </Txt>
                <Pressable
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`Answer question ${question.n} in this reply`}
                  onPress={() => toggle(question.n)}
                  hitSlop={8}
                >
                  <Txt v="meta" tone="accent">
                    {on ? "Leave for later" : "Answer"}
                  </Txt>
                </Pressable>
              </View>
              {on ? (
                <>
                  {options.map((option) => (
                    <OptionRow
                      key={text(option.id)}
                      label={text(option.label)}
                      description={text(option.description) || undefined}
                      recommended={option.recommended === true}
                      selected={(draft.picks[question.n] ?? []).includes(text(option.id))}
                      multi={multi}
                      disabled={busy}
                      onPress={() => pick(question.n, text(option.id), multi)}
                    />
                  ))}
                  {question.item.allowOther === false && options.length ? null : (
                    <Field
                      label={options.length ? "Note" : "Your answer"}
                      value={draft.other[question.n] ?? ""}
                      onChange={(value) =>
                        setDraft((previous) => ({
                          ...previous,
                          other: { ...previous.other, [question.n]: value },
                        }))
                      }
                      placeholder={options.length ? "Optional" : undefined}
                      multiline
                      disabled={busy}
                    />
                  )}
                </>
              ) : null}
            </Card>
          );
        })}
        <Field
          label={questions.length ? "Anything else" : "Reply"}
          value={draft.extra}
          onChange={(value) => setDraft((previous) => ({ ...previous, extra: value }))}
          placeholder={questions.length ? "A new topic, a correction…" : undefined}
          multiline
          autoFocus={!questions.length}
          disabled={busy}
        />
        {quoted.length ? (
          <Txt v="meta" tone="muted">
            {`${answered} of ${quoted.length} answered. Empty ones are told to wait.`}
          </Txt>
        ) : null}
      </ScrollView>
      <View style={[styles.bar, { borderTopColor: c.border, paddingBottom: insets.bottom + 8 }]}>
        <Button
          label="Send & settle"
          disabled={busy || !online || empty}
          onPress={() => void send(true)}
        />
        <Button
          label={busy ? "Sending…" : "Send reply"}
          kind="primary"
          style={styles.flex}
          disabled={busy || !online || empty}
          onPress={() => void send(false)}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  quote: { flexDirection: "row", gap: 8, paddingLeft: 10, borderLeftWidth: 2 },
  bar: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
});
