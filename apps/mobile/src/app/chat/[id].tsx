import { type ArtifactTarget, isStopPhrase } from "@zoltbot/protocol";
import { chiefName, chiefThreadId } from "@zoltbot/ui/chief/data";
import { selectedRequest } from "@zoltbot/ui/interactions/request-presentation";
import { router, useLocalSearchParams } from "expo-router";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
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
import { withAsides } from "../../data/asides";
import { type Attachment, composeInput } from "../../data/attachments";
import { chatAccount } from "../../data/backup-models";
import { conversation } from "../../data/conversation";
import { editsOf, forkInfo } from "../../data/forks";
import { withHidden } from "../../data/hidden";
import { pendingFor } from "../../data/interactions";
import { pinnedRows } from "../../data/pins";
import { editableQueued, inQueueOrder, moved, queuedIds } from "../../data/queue-order";
import { compactions, latestPlan, modelState, threadSession } from "../../data/session";
import { isStaffApproval } from "../../data/staff";
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
import { BotAvatar } from "../../ui/BotAvatar";
import { ChatOutcome, ChatWaiting } from "../../ui/ChatOutcome";
import { ContextChip } from "../../ui/ContextChip";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { ForkBanner } from "../../ui/ForkBanner";
import { Icon, StopGlyph } from "../../ui/icons";
import { InteractionCard } from "../../ui/interactions/InteractionCard";
import { Button, Chip, Segmented, Txt } from "../../ui/kit";
import { messageMarks } from "../../ui/message-marks";
import { PinStrip } from "../../ui/PinStrip";
import { useRowPositions } from "../../ui/row-positions";
import { ModelChip, PlanChecklist } from "../../ui/SessionControls";
import { TaskContext } from "../../ui/TaskContext";
import { Message, type QueueActions } from "../../ui/Transcript";
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
  const [following, setFollowing] = useState(true);
  const thread = (snapshot.entities.thread ?? []).find((row) => row.id === id);
  const queue = queuedIds(snapshot, id);
  const rows = withHidden(
    snapshot,
    id,
    withAsides(snapshot, id, inQueueOrder(transcript(snapshot, id), queue)),
  );
  const positions = useRowPositions();
  const pinned = pinnedRows(snapshot, id, rows);
  const turn = runningTurn(snapshot, id);
  const who = profileName(snapshot, thread?.agentId);
  const chief = chiefThreadId(snapshot.entities) === id;
  const title = chief ? chiefName(snapshot.entities) : text(thread?.title) || "Chat";
  const location = place(snapshot, thread);
  const session = threadSession(snapshot, id);
  const compareMember = snapshot.entities.compareMember?.find((m) => m.threadId === id);
  const compare = snapshot.entities.compare?.find(
    (g) => g.id === compareMember?.compareId || g.summaryThreadId === id,
  );
  const compareReadOnly = compareMember?.ceiling === "read_only" || compare?.summaryThreadId === id;
  const pinnedIds = new Set(pinned.map((row) => row.id));
  const marks = online ? messageMarks(id, pinnedIds, run) : undefined;
  // Staff approvals are cards in the transcript, not the pinned request.
  const pending = pendingFor(snapshot, id).filter((row) => !isStaffApproval(row));
  const [selected, setSelected] = useState<string>();
  const request = selectedRequest(pending, selected);
  useEffect(() => setSelected(request?.id), [request?.id]);
  const { height } = useWindowDimensions();
  const fork = forkInfo(snapshot, id);
  const edits = editsOf(snapshot, id);
  // Steering reaches the running turn only where the agent supports it; otherwise it waits.
  const canSteer =
    !artifactTarget && !!turn && (session?.capabilities as Row | undefined)?.steer === "native";
  // C2: while the agent works, a message can also go as a side question, without stopping it.
  const canAside = !artifactTarget && !!turn;
  const [delivery, setDelivery] = useState<"steer" | "queue" | "aside">("steer");
  // The choice ends with the turn, as on the Mac: the next turn starts at Send now.
  useEffect(() => {
    if (!turn) setDelivery("steer");
  }, [turn]);
  const send = async () => {
    const message = draft.trim();
    if (!message && !attachments.length) return;
    // A bare "stop" while the agent works stops the turn instead of queueing a message.
    if (turn && !attachments.length && isStopPhrase(message)) {
      const stopped = await run("turn.interrupt", { threadId: id, turnId: text(turn.id) });
      if (stopped) {
        setDraft("");
        AccessibilityInfo.announceForAccessibility("Stopped");
      }
      return;
    }
    if (canAside && delivery === "aside") {
      if (attachments.length) {
        Alert.alert("Side questions can’t include attachments.");
        return;
      }
      const asked = await run("turn.aside", { threadId: id, text: message });
      if (asked) {
        followLatest.current = true;
        setFollowing(true);
        setDraft("");
        AccessibilityInfo.announceForAccessibility("Asked aside");
      }
      return;
    }
    const result = await run("turn.send", {
      threadId: id,
      input: composeInput(message, attachments),
      ...(artifactTarget ? { artifactTarget } : {}),
      mode: canSteer && delivery === "steer" ? "steer" : "queue",
    });
    if (result) {
      followLatest.current = true;
      setFollowing(true);
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
  // C1: a queued message can also be sent now, moved or removed.
  const queueActions = (row: TranscriptRow): QueueActions => {
    const reorder = (to: number) => {
      const order = moved(queue, row.id, to);
      return order ? () => void run("turn.reorderQueued", { threadId: id, order }) : undefined;
    };
    const at = queue.indexOf(row.id);
    const up = reorder(at - 1);
    const down = reorder(at + 1);
    return {
      sendNow: () => void run("turn.sendQueuedNow", { threadId: id, id: row.id }),
      remove: () => void run("turn.cancelQueued", { threadId: id, id: row.id }),
      ...(up ? { moveUp: up } : {}),
      ...(down ? { moveDown: down } : {}),
    };
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
          <BotAvatar id={id} zolt={chief} working={!!turn} />
          <View style={styles.title}>
            <Txt v="cardTitle" lines={2} accessibilityRole="header">
              {title}
            </Txt>
            {location ? (
              <Txt v="meta" tone="muted" lines={2}>
                {location}
              </Txt>
            ) : null}
          </View>
        </Pressable>
        <ContextChip
          threadId={id}
          turnId={turn ? text(turn.id) : undefined}
          compactions={compactions(snapshot, id)}
        />
        <Pressable
          onPress={() => router.push(`/chat/options?id=${encodeURIComponent(id)}`)}
          accessibilityRole="button"
          accessibilityLabel="Chat options"
          style={styles.bell}
        >
          <Icon name="settings" color={c["text-secondary"]} size={22} />
        </Pressable>
      </View>
      <PlanChecklist key={id} plan={latestPlan(snapshot, id)} />
      <PinStrip
        pins={pinned}
        onJump={(row) => {
          followLatest.current = false;
          setFollowing(false);
          void positions.jump(row.id, scroll);
        }}
      />
      <ChatWaiting threadId={id} />

      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.body}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={100}
        onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
          const nearEnd = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
          followLatest.current = nearEnd;
          setFollowing(nearEnd);
        }}
        onContentSizeChange={() => {
          if (followLatest.current) scroll.current?.scrollToEnd({ animated: false });
        }}
      >
        <OfflineBanner />
        {!thread ? (
          <Txt tone="muted">Chat unavailable.</Txt>
        ) : rows.length === 0 ? (
          <Txt tone="muted">Send a message to {title}.</Txt>
        ) : null}
        <WakeStatus
          rows={(snapshot.entities.wake ?? []).filter((w) => w.threadId === id)}
          online={online}
        />
        {fork ? <ForkBanner threadId={id} info={fork} /> : null}
        {snapshot.entities.task
          ?.filter((task) => task.threadId === id)
          .map((task) => (
            <TaskContext key={String(task.id)} task={task} online={online} />
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
            <View
              key={`${entry.id}:${entry.rows[0]?.id ?? "pending"}`}
              onLayout={positions.block(entry.rows.map((r) => r.id))}
            >
              <AssistantTurn
                rows={entry.rows}
                track={positions.row}
                {...(marks ? { marks } : {})}
                active={entry.active}
                paused={!!request || !online}
                onInspect={() => {
                  followLatest.current = false;
                  setFollowing(false);
                }}
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
            </View>
          ) : row ? (
            <View key={row.id} ref={positions.node(row.id)} onLayout={positions.block([row.id])}>
              <Message
                threadId={id}
                row={row}
                {...(marks ? { marks } : {})}
                {...(online && !busy && editableQueued(snapshot, row.id)
                  ? { onEdit: (queued: TranscriptRow) => void edit(queued) }
                  : {})}
                {...(online && !busy && row.queued ? { queue: queueActions(row) } : {})}
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
            </View>
          ) : null;
        })}
        <ChatOutcome threadId={id} />
      </ScrollView>
      {!following ? (
        <Button
          kind="plain"
          label="Jump to latest"
          onPress={() => {
            followLatest.current = true;
            setFollowing(true);
            scroll.current?.scrollToEnd({ animated: false });
          }}
        />
      ) : null}
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
        accessibilityLabel={`Message ${title}`}
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
            <ModelChip
              state={modelState(snapshot, session)}
              online={online}
              account={chatAccount(snapshot, id)}
            />
          )}
          {canAside && !compareReadOnly ? (
            <Segmented<"steer" | "queue" | "aside">
              label="Send while the agent works"
              value={delivery === "steer" && !canSteer ? "queue" : delivery}
              onChange={setDelivery}
              options={[
                ...(canSteer ? [{ value: "steer" as const, label: "Send now" }] : []),
                { value: "queue", label: "Queue next" },
                { value: "aside", label: "Aside" },
              ]}
            />
          ) : null}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={canAside && delivery === "aside" ? "Ask aside…" : "Message"}
            placeholderTextColor={c["text-dim"]}
            multiline
            editable={online && !!thread}
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
              disabled={!online || !thread || busy || (!draft.trim() && !attachments.length)}
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
    paddingEnd: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bell: { width: touch, height: touch, alignItems: "center", justifyContent: "center" },
  controls: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  who: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch },
  title: { flex: 1, minWidth: 0 },
  body: { paddingHorizontal: 16, paddingVertical: 16, gap: 16, flexGrow: 1 },
  pinned: { flexGrow: 0, borderTopWidth: StyleSheet.hairlineWidth },
  pinnedBody: { padding: 16 },
  composer: {
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
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
