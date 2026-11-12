import type { ArtifactTarget } from "@zoltbot/protocol";
import { selectedRequest } from "@zoltbot/ui/interactions/request-presentation";
import { router, useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { artifactReference } from "../../data/artifacts";
import { type Attachment, composeInput } from "../../data/attachments";
import { conversation } from "../../data/conversation";
import { editsOf, forkInfo } from "../../data/forks";
import { pendingFor } from "../../data/interactions";
import { latestPlan, modelState, threadSession } from "../../data/session";
import type { Row } from "../../data/transport";
import {
  place,
  profileName,
  runningTurn,
  type TranscriptRow,
  text,
  transcript,
} from "../../data/view";
import { useAction } from "../../state/actions";
import { useChatDraft } from "../../state/chat-draft";
import { useClient, useSnapshot } from "../../state/link";
import { donateBotConversation } from "../../state/sharing";
import { sans, touch, useTheme } from "../../theme";
import { AssistantTurn } from "../../ui/AssistantTurn";
import { Attachments } from "../../ui/Attachments";
import { ChatOutcome, ChatWaiting } from "../../ui/ChatOutcome";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { ForkBanner } from "../../ui/ForkBanner";
import { Icon, StopGlyph } from "../../ui/icons";
import { InteractionCard } from "../../ui/interactions/InteractionCard";
import { Avatar, Button, Chip, Segmented, Txt } from "../../ui/kit";
import { ModelChip, PlanChecklist } from "../../ui/SessionControls";
import { ShippingContext } from "../../ui/ShippingContext";
import { Message } from "../../ui/Transcript";
import { WakeStatus } from "../../ui/WakeStatus";

export default function Chat() {
  // A Quick Chat handoff passes its brief to wait in the composer, unsent.
  const { id, draft: brief } = useLocalSearchParams<{ id: string; draft?: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const [draft, setDraft] = useState(brief ?? "");
  const [artifactTarget, setArtifactTarget] = useState<ArtifactTarget>();
  const incoming = useChatDraft((s) => s.draft);
  useEffect(() => {
    if (incoming?.threadId !== id) return;
    const handoff = useChatDraft.getState().take(id);
    if (!handoff) return;
    setDraft((current) => (current.trim() ? `${current}\n\n${handoff.text}` : handoff.text));
    setArtifactTarget(handoff.target);
  }, [id, incoming]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const followLatest = useRef(true);
  const thread = (snapshot.entities.thread ?? []).find((row) => row.id === id);
  const rows = transcript(snapshot, id);
  const turn = runningTurn(snapshot, id);
  const who = profileName(snapshot, thread?.agentId);
  const session = threadSession(snapshot, id);
  const compareMember = snapshot.entities.compareMember?.find((m) => m.threadId === id);
  const compare = snapshot.entities.compare?.find(
    (g) => g.id === compareMember?.compareId || g.summaryThreadId === id,
  );
  const compareReadOnly = compareMember?.ceiling === "read_only" || compare?.summaryThreadId === id;
  const pending = pendingFor(snapshot, id);
  const [selected, setSelected] = useState<string>();
  const request = selectedRequest(pending, selected);
  useEffect(() => setSelected(request?.id), [request?.id]);
  const { height } = useWindowDimensions();
  const fork = forkInfo(snapshot, id);
  const edits = editsOf(snapshot, id);
  // Steering reaches the running turn only where the agent supports it; otherwise it waits.
  const canSteer =
    !artifactTarget && !!turn && (session?.capabilities as Row | undefined)?.steer === "native";
  const [delivery, setDelivery] = useState<"steer" | "queue">("steer");
  const send = async () => {
    const message = draft.trim();
    if (!message && !attachments.length) return;
    const result = await run("turn.send", {
      threadId: id,
      input: composeInput(message, attachments),
      ...(artifactTarget ? { artifactTarget } : {}),
      mode: canSteer ? delivery : "queue",
    });
    if (result) {
      followLatest.current = true;
      void donateBotConversation(id).catch(() => undefined);
      setDraft("");
      setAttachments([]);
      setArtifactTarget(undefined);
    }
  };
  const stop = () => turn && void run("turn.interrupt", { threadId: id, turnId: text(turn.id) });
  // Taking a queued message back cancels it on the Mac, then puts its words in the composer.
  const edit = async (row: TranscriptRow) => {
    const result = await run("turn.cancelQueued", { threadId: id, id: row.id });
    if (result) setDraft((current) => (current.trim() ? `${row.text}\n${current}` : row.text));
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.page, { backgroundColor: c["bg-page"] }]}
    >
      <View style={[styles.header, { paddingTop: insets.top + 4, borderBottomColor: c.border }]}>
        <BackBar label="the list" iconOnly />
        <Pressable
          onPress={() => thread && router.push(`/profile/${text(thread.agentId)}`)}
          accessibilityRole="button"
          accessibilityHint={`Opens ${who}’s profile`}
          style={styles.who}
        >
          <Avatar id={text(thread?.agentId)} />
          <View style={styles.title}>
            <Txt v="cardTitle" lines={1} accessibilityRole="header">
              {text(thread?.title) || "Chat"}
            </Txt>
            <Txt v="meta" tone="muted" lines={1}>
              {[who, place(snapshot, thread)].filter(Boolean).join(" · ")}
            </Txt>
          </View>
        </Pressable>
        <Pressable
          onPress={() => router.push(`/chat/options?id=${encodeURIComponent(id)}`)}
          accessibilityRole="button"
          accessibilityLabel="Chat options"
          style={styles.bell}
        >
          <Icon name="settings" color={c["text-secondary"]} size={22} />
        </Pressable>
      </View>
      <PlanChecklist plan={latestPlan(snapshot, id)} />
      <ChatWaiting threadId={id} />

      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.body}
        scrollEventThrottle={100}
        onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          followLatest.current =
            contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
        }}
        onContentSizeChange={() => {
          if (followLatest.current) scroll.current?.scrollToEnd({ animated: false });
        }}
      >
        <OfflineBanner />
        <WakeStatus
          rows={(snapshot.entities.wake ?? []).filter((w) => w.threadId === id)}
          online={online}
        />
        {fork ? <ForkBanner threadId={id} info={fork} /> : null}
        {snapshot.entities.task
          ?.filter((task) => task.threadId === id)
          .map((task) => (
            <ShippingContext key={String(task.id)} task={task} />
          ))}
        {compare && !rows.some((row) => row.compareId) ? (
          <Button
            label="View side by side"
            onPress={() => router.push(`/chat/compare/${text(compare.id)}`)}
          />
        ) : null}
        {rows.length === 0 && !turn ? (
          <Txt tone="muted">{`Say what you want ${who} to do.`}</Txt>
        ) : null}
        {conversation(rows, snapshot, turn ? text(turn.id) : undefined).map((entry) => {
          const row = entry.kind === "row" ? entry.row : undefined;
          return entry.kind === "assistant" ? (
            <AssistantTurn
              key={`${entry.id}:${entry.rows[0]?.id ?? "pending"}`}
              rows={entry.rows}
              active={entry.active}
              paused={!!request || !online}
              threadId={id}
              {...(online
                ? {
                    onForward: (message: TranscriptRow) =>
                      router.push(
                        `/chat/send?id=${encodeURIComponent(id)}&item=${encodeURIComponent(message.id)}`,
                      ),
                  }
                : {})}
            />
          ) : row ? (
            <Message
              threadId={id}
              key={row.id}
              row={row}
              {...(online && !busy ? { onEdit: (queued: TranscriptRow) => void edit(queued) } : {})}
              {...(row.turnId && edits.get(row.turnId)?.length
                ? {
                    edits: {
                      count: edits.get(row.turnId)?.length ?? 0,
                      open: () => router.push(`/chat/${edits.get(row.turnId ?? "")?.[0]}`),
                    },
                  }
                : {})}
              {...(online
                ? {
                    onForward: (message: TranscriptRow) =>
                      router.push(
                        `/chat/send?id=${encodeURIComponent(id)}&item=${encodeURIComponent(message.id)}`,
                      ),
                  }
                : {})}
              {...(compareReadOnly
                ? {}
                : {
                    onEditSent: (sent: TranscriptRow) =>
                      router.push(
                        `/chat/edit?id=${encodeURIComponent(id)}&turnId=${encodeURIComponent(sent.turnId ?? "")}`,
                      ),
                  })}
            />
          ) : null;
        })}
        <ChatOutcome threadId={id} />
      </ScrollView>
      {request ? (
        <ScrollView
          style={[styles.pinned, { maxHeight: height * 0.6, borderTopColor: c.border }]}
          contentContainerStyle={styles.pinnedBody}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel="Needs your answer"
        >
          <InteractionCard
            key={request.id}
            request={request}
            who={profileName(snapshot, request.agentId)}
            {...(pending.length > 1
              ? {
                  position: `${pending.findIndex((row) => row.id === request.id) + 1} of ${pending.length} waiting`,
                }
              : {})}
          />
        </ScrollView>
      ) : null}
      <Attachments value={attachments} onChange={setAttachments} threadId={id} disabled={busy} />
      <View
        style={[
          styles.composer,
          { borderTopColor: c.border, paddingBottom: Math.max(insets.bottom, 10) },
        ]}
        accessibilityLabel={`Message ${who}`}
      >
        {artifactTarget ? (
          <View style={{ gap: 8 }}>
            <Txt tone="secondary">
              Selected saved version: {artifactReference(snapshot, artifactTarget)}
            </Txt>
            <Button label="Remove version reference" onPress={() => setArtifactTarget(undefined)} />
          </View>
        ) : null}
        <View style={styles.controls}>
          {compareReadOnly ? (
            <Chip label="Read only · Compare" />
          ) : (
            <ModelChip state={modelState(snapshot, session)} online={online} />
          )}
          {canSteer && !compareReadOnly ? (
            <Segmented<"steer" | "queue">
              label="Send while the agent works"
              value={delivery}
              onChange={setDelivery}
              options={[
                { value: "steer", label: "Send now" },
                { value: "queue", label: "Queue next" },
              ]}
            />
          ) : null}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Message ${who}`}
            placeholderTextColor={c["text-dim"]}
            multiline
            editable={online}
            accessibilityLabel="Message"
            style={[
              styles.input,
              { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
            ]}
          />
          {turn && !draft.trim() && !attachments.length ? (
            <Pressable
              onPress={stop}
              disabled={!online || busy}
              accessibilityRole="button"
              accessibilityLabel="Stop"
              style={[styles.round, { backgroundColor: c.text, opacity: online ? 1 : 0.45 }]}
            >
              <StopGlyph color={c["bg-page"]} />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void send()}
              disabled={!online || busy || (!draft.trim() && !attachments.length)}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={[
                styles.round,
                {
                  backgroundColor: c.primary,
                  opacity: online && (draft.trim() || attachments.length) ? 1 : 0.45,
                },
              ]}
            >
              <Icon name="send" color={c["text-on-primary"]} size={20} stroke={2} />
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingRight: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bell: { width: touch, height: touch, alignItems: "center", justifyContent: "center" },
  controls: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  who: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch },
  title: { flex: 1, minWidth: 0 },
  body: { padding: 16, gap: 14, flexGrow: 1, justifyContent: "flex-end" },
  pinned: { flexGrow: 0, borderTopWidth: StyleSheet.hairlineWidth },
  pinnedBody: { padding: 12 },
  composer: {
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: {
    fontFamily: sans,
    flex: 1,
    minHeight: touch,
    maxHeight: 140,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 15,
  },
  round: {
    width: touch,
    height: touch,
    borderRadius: touch / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
