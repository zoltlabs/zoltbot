import { chiefThreadId } from "@zoltbot/ui/chief/data";
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
import { type Attachment, composeInput } from "../../data/attachments";
import { threadChanges } from "../../data/changes";
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
import { useClient, useLink, useSnapshot } from "../../state/link";
import { donateBotConversation } from "../../state/sharing";
import { sans, touch, useTheme } from "../../theme";
import { Attachments } from "../../ui/Attachments";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { ForkBanner } from "../../ui/ForkBanner";
import { Icon, StopGlyph } from "../../ui/icons";
import { InteractionCard } from "../../ui/interactions/InteractionCard";
import { Avatar, Button, Chip, Segmented, Txt } from "../../ui/kit";
import { BackgroundChip, ModeChip, ModelChip, PlanChecklist } from "../../ui/SessionControls";
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
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
  const request = pending[0];
  const { height } = useWindowDimensions();
  const chief = chiefThreadId(snapshot.entities) === id;
  const fork = forkInfo(snapshot, id);
  const edits = editsOf(snapshot, id);
  const changed = new Set(
    threadChanges(snapshot, id).flatMap((turn) => turn.files.map((f) => f.path)),
  ).size;
  // Terminals live on the Mac, not in the snapshot; any open one (any device's) gets a link.
  const [terminals, setTerminals] = useState(0);
  useEffect(() => {
    const client = useLink.getState().client?.getState();
    if (!client || !online) return;
    let live = true;
    client
      .call("terminal.list", { threadId: id, readOnly: true })
      .then(
        (value) =>
          live && setTerminals((((value ?? {}) as { items?: unknown[] }).items ?? []).length),
      )
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, online]);
  // Steering reaches the running turn only where the agent supports it; otherwise it waits.
  const canSteer = !!turn && (session?.capabilities as Row | undefined)?.steer === "native";
  const [delivery, setDelivery] = useState<"steer" | "queue">("steer");
  const send = async () => {
    const message = draft.trim();
    if (!message && !attachments.length) return;
    const result = await run("turn.send", {
      threadId: id,
      input: composeInput(message, attachments),
      mode: canSteer ? delivery : "queue",
    });
    if (result) {
      void donateBotConversation(id).catch(() => undefined);
      setDraft("");
      setAttachments([]);
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
        <BackgroundChip session={session} />
        {changed ? (
          <Pressable
            onPress={() => router.push(`/chat/changes?id=${encodeURIComponent(id)}`)}
            accessibilityRole="button"
            accessibilityLabel={`Changes: ${changed} ${changed === 1 ? "file" : "files"}`}
            hitSlop={6}
          >
            <Chip label={`${changed} ${changed === 1 ? "file" : "files"}`} />
          </Pressable>
        ) : null}
        {terminals ? (
          <Pressable
            onPress={() => router.push(`/chat/terminal?id=${encodeURIComponent(id)}`)}
            accessibilityRole="button"
            accessibilityLabel="Terminal"
            hitSlop={6}
          >
            <Chip label="Terminal" />
          </Pressable>
        ) : null}
        {compareReadOnly || chief ? null : (
          <Pressable
            onPress={() => router.push(`/chat/fork?id=${encodeURIComponent(id)}`)}
            disabled={!online}
            accessibilityRole="button"
            accessibilityLabel="Fork chat"
            hitSlop={6}
            style={[styles.bell, !online && { opacity: 0.45 }]}
          >
            <Icon name="fork" color={c["accent-text"]} size={20} stroke={1.8} />
          </Pressable>
        )}
        {chief ? (
          <Pressable
            onPress={() => router.push("/zolt-settings")}
            accessibilityRole="button"
            accessibilityLabel="Brief and notifications"
            hitSlop={6}
            style={styles.bell}
          >
            <Icon name="bell" color={c["accent-text"]} size={22} stroke={1.8} />
          </Pressable>
        ) : null}
        {turn ? <Chip label="Working" tone="accent" dot /> : null}
      </View>
      <PlanChecklist plan={latestPlan(snapshot, id)} />
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.body}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
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
        {rows.length === 0 ? <Txt tone="muted">{`Say what you want ${who} to do.`}</Txt> : null}
        {rows.map((row) => (
          <Message
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
        ))}
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
            {...(pending.length > 1 ? { position: `1 of ${pending.length} waiting` } : {})}
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
        <View style={styles.controls}>
          {compareReadOnly ? (
            <Chip label="Read only · Compare" />
          ) : (
            <>
              <ModeChip session={session} online={online} />
              <ModelChip state={modelState(snapshot, session)} online={online} />
            </>
          )}
          {canSteer && !compareReadOnly ? (
            <Segmented<"steer" | "queue">
              label="While it works"
              value={delivery}
              onChange={setDelivery}
              options={[
                { value: "steer", label: "Steer" },
                { value: "queue", label: "Queue" },
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
