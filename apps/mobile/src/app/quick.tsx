import type {
  QuickChat as Chat,
  QuickConnection,
  QuickContextSource,
  QuickMessage,
  QuickSettings,
} from "@zoltbot/protocol";
import {
  applyQuickEvent,
  billingLabel,
  connectionStatus,
  errorText,
  initialSelection,
  outcomeText,
  replyLabel,
  requestOutcome,
  sourceLabel,
  toolName,
  toolSummary,
  usable,
} from "@zoltbot/ui/quick-chat/data";
import { router, useLocalSearchParams } from "expo-router";
import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { text } from "../data/view";
import { useClient, useLink, useSnapshot } from "../state/link";
import { sans, touch, useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Icon, StopGlyph } from "../ui/icons";
import { Button, Chip, Group, Row, Txt } from "../ui/kit";
import { Markdown } from "../ui/Markdown";
import { QuickHandoff } from "../ui/QuickHandoff";

// Drafts stay on this phone while the app runs, per chat, so leaving the screen loses nothing.
const drafts = new Map<string, string>();

/**
 * Quick Chat from the phone. Inference runs on the Mac with the person's own connections; the
 * phone never holds provider keys. Setting up keys, sign-in and fallback stays on the Mac.
 */
export default function Quick() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const chatId = id || undefined;
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const call = useClient((state) => state.call);
  const client = useLink((state) => state.client);
  const [view, setView] = useState<{
    chats: Chat[];
    messages: QuickMessage[];
    chatId?: string | undefined;
  }>({ chats: [], messages: [] });
  const { chats, messages } = view;
  const [connections, setConnections] = useState<QuickConnection[]>();
  const [settings, setSettings] = useState<QuickSettings>();
  const [selection, setSelection] = useState<{ connectionId: string; model: string }>();
  const [sources, setSources] = useState<QuickContextSource[]>([]);
  const [draft, setDraftState] = useState(() => drafts.get(chatId ?? "new") ?? "");
  const [notice, setNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const lastSent = useRef<{ replyId: string; text: string }>(undefined);
  const setDraft = (value: string) => {
    setDraftState(value);
    drafts.set(chatId ?? "new", value);
  };
  const loadConnections = useCallback(async () => {
    const result = (await call("quickConnection.list", {})) as {
      items: QuickConnection[];
      settings: QuickSettings;
    };
    setConnections(result.items);
    setSettings(result.settings);
    setSelection((previous) => initialSelection(result.items, result.settings, previous));
  }, [call]);
  useEffect(() => {
    if (!online) return;
    let live = true;
    void (async () => {
      const [list, current] = await Promise.all([
        call("quickChat.list", {}) as Promise<{ items: Chat[] }>,
        chatId
          ? (
              call("quickChat.get", { id: chatId }) as Promise<{
                chat: Chat;
                messages: QuickMessage[];
              }>
            ).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      await loadConnections();
      if (!live) return;
      setView({ chats: list.items, messages: current?.messages ?? [], chatId });
      setSources(current?.chat.contextSources ?? []);
      if (current?.chat.lastConnectionId)
        setSelection((previous) => ({
          connectionId: current.chat.lastConnectionId ?? previous?.connectionId ?? "",
          model: current.chat.lastModel ?? previous?.model ?? "",
        }));
    })().catch((error) => live && setNotice(errorText(error)));
    return () => {
      live = false;
    };
  }, [online, chatId, call, loadConnections]);
  useEffect(() => {
    setDraftState(drafts.get(chatId ?? "new") ?? "");
    setNotice("");
  }, [chatId]);
  useEffect(
    () =>
      client?.onEvent((event) => {
        if (event.type === "quickConnection.changed") void loadConnections();
        setView((current) => applyQuickEvent(current, event));
      }),
    [client, loadConnections],
  );
  // A refused reply gives the question back to the composer so nothing typed is lost.
  useEffect(() => {
    const sent = lastSent.current;
    const reply = sent && messages.find((row) => row.id === sent.replyId);
    if (!sent || !reply || reply.status === "streaming") return;
    lastSent.current = undefined;
    if (reply.status === "failed") {
      setNotice(`${reply.error?.message ?? "Not answered."} Your message is back below.`);
      setDraftState((current) => current || sent.text);
    }
  }, [messages]);
  const selected = connections?.find((row) => row.id === selection?.connectionId);
  const streaming = messages.find((row) => row.role === "assistant" && row.status === "streaming");
  const chat = chats.find((row) => row.id === chatId);
  const projects = (snapshot.entities.project ?? []).filter((row) => !row.archived);
  const send = async () => {
    const value = draft.trim();
    if (!value || !selected || !selection?.model || sending) return;
    setSending(true);
    setNotice("");
    try {
      const result = (await call("quickChat.send", {
        ...(chatId ? { chatId } : {}),
        text: value,
        connectionId: selected.id,
        model: selection.model,
        contextSources: sources,
      })) as { chatId: string; replyId: string };
      lastSent.current = { replyId: result.replyId, text: value };
      setDraft("");
      if (!chatId) {
        drafts.delete("new");
        router.setParams({ id: result.chatId });
      }
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setSending(false);
    }
  };
  const updateSources = (next: QuickContextSource[]) => {
    setSources(next);
    if (chatId) void call("quickChat.setContext", { id: chatId, contextSources: next });
  };
  const addContext = () => {
    const buttons = projects.slice(0, 6).map((row) => ({
      text: text(row.name),
      onPress: () =>
        Alert.alert(text(row.name), "What should Quick Chat read from this workspace?", [
          {
            text: "Search its files",
            onPress: () =>
              updateSources([
                ...sources.filter((source) => source.id !== `workspace:${row.id}`),
                {
                  id: `workspace:${row.id}`,
                  kind: "workspace",
                  projectId: text(row.id),
                  label: text(row.name),
                },
              ]),
          },
          {
            text: "Workspace brief",
            onPress: () =>
              updateSources([
                ...sources.filter((source) => source.id !== `brief:project:${row.id}`),
                {
                  id: `brief:project:${row.id}`,
                  kind: "brief",
                  scope: { type: "project", id: text(row.id) },
                  label: text(row.name),
                },
              ]),
          },
          { text: "Cancel", style: "cancel" },
        ]),
    }));
    Alert.alert(
      "Add context",
      `Read on your Mac, filtered for secrets, and sent with your next message to ${
        selected ? billingLabel({ ...selected, hostName: selected.host.name }) : "your connection"
      }. Quick Chat only reads.`,
      [...buttons, { text: "Cancel", style: "cancel" }],
    );
  };
  const chooseConnection = () =>
    Alert.alert(
      "Connection",
      "Each one is paid for by you: a coding tool you signed in to, your own API key, or a local model.",
      [
        ...(connections ?? []).filter(usable).map((row) => ({
          text: `${row.label} · ${billingLabel({ ...row, hostName: row.host.name })}`,
          onPress: () => setSelection(initialSelection([row], settings, { connectionId: row.id })),
        })),
        { text: "Cancel", style: "cancel" as const },
      ],
    );
  const chooseModel = () =>
    selected &&
    Alert.alert("Model", `Models ${selected.label} offers.`, [
      ...selected.models.slice(0, 8).map((model) => ({
        text: model.label,
        onPress: () => setSelection({ connectionId: selected.id, model: model.id }),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  const manage = (row: Chat) =>
    Alert.alert(row.title, undefined, [
      {
        text: "Rename",
        onPress: () =>
          Alert.prompt("Rename chat", undefined, (title) => {
            if (title?.trim())
              void call("quickChat.rename", { id: row.id, title: title.trim() }).catch((error) =>
                setNotice(errorText(error)),
              );
          }),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          Alert.alert("Delete this chat?", "Its messages are removed from your Mac.", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Delete",
              style: "destructive",
              onPress: () =>
                void call("quickChat.delete", { id: row.id, confirmed: true }).then(
                  () => {
                    drafts.delete(row.id);
                    if (row.id === chatId) router.setParams({ id: "" });
                  },
                  (error) => setNotice(errorText(error)),
                ),
            },
          ]),
      },
      { text: "Cancel", style: "cancel" },
    ]);
  const ready = Boolean(connections?.some(usable));
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.page, { backgroundColor: c["bg-page"] }]}
    >
      <View style={[styles.header, { paddingTop: insets.top + 4, borderBottomColor: c.border }]}>
        <BackBar label="Chats" iconOnly />
        <View style={styles.title}>
          <Txt v="cardTitle" lines={1} accessibilityRole="header">
            {chat?.title ?? "Quick chat"}
          </Txt>
        </View>
        {chatId ? (
          <Button label="New" kind="plain" onPress={() => router.setParams({ id: "" })} />
        ) : null}
      </View>
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => chatId && scroll.current?.scrollToEnd({ animated: true })}
      >
        <OfflineBanner />
        {connections && !ready ? (
          <Txt tone="muted">
            Sign in to Codex, Claude Code or Antigravity on your Mac, add your own API key, or
            connect a local model.
          </Txt>
        ) : null}
        {!chatId ? (
          <>
            <Txt tone="muted">Ask anything. Add workspace context only when you want it.</Txt>
            {chats.length ? (
              <>
                <Txt v="meta" tone="muted">
                  Recent chats
                </Txt>
                <Group>
                  {chats.map((row, index) => (
                    <Row
                      key={row.id}
                      title={row.title}
                      meta={new Date(row.updatedAt).toLocaleString()}
                      last={index === chats.length - 1}
                      onPress={() => router.setParams({ id: row.id })}
                      right={
                        <Pressable
                          onPress={() => manage(row)}
                          accessibilityRole="button"
                          accessibilityLabel={`Rename or delete ${row.title}`}
                          hitSlop={8}
                        >
                          <Txt tone="muted">⋯</Txt>
                        </Pressable>
                      }
                    />
                  ))}
                </Group>
              </>
            ) : null}
          </>
        ) : (
          <>
            {chat ? (
              <View style={styles.actions}>
                <Button label="Rename or delete" kind="plain" onPress={() => manage(chat)} />
                <Button
                  label="Continue in workspace"
                  kind="secondary"
                  onPress={() => setHandoff(true)}
                />
              </View>
            ) : null}
            {handoff && chatId ? (
              <QuickHandoff chatId={chatId} onClose={() => setHandoff(false)} />
            ) : null}
            {messages.map((message) => (
              <QuickRow
                key={message.id}
                message={message}
                onAnswer={(requestId, decision, optionId) =>
                  void call("quickChat.respond", {
                    replyId: message.id,
                    requestId,
                    decision,
                    ...(optionId ? { optionId } : {}),
                  }).catch((error) => Alert.alert("Not sent", errorText(error)))
                }
              />
            ))}
          </>
        )}
      </ScrollView>
      <View
        style={[
          styles.composer,
          { borderTopColor: c.border, paddingBottom: Math.max(insets.bottom, 10) },
        ]}
      >
        {sources.length ? (
          <View style={styles.chips} accessibilityLabel="Context sources">
            {sources.map((source) => (
              <Pressable
                key={source.id}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${sourceLabel(source)}`}
                onPress={() => updateSources(sources.filter((row) => row.id !== source.id))}
              >
                <Chip label={`${sourceLabel(source)} ×`} tone="accent" />
              </Pressable>
            ))}
          </View>
        ) : null}
        {notice ? <Txt v="meta">{notice}</Txt> : null}
        <View style={styles.inputRow}>
          <Pressable
            onPress={addContext}
            disabled={!projects.length}
            accessibilityRole="button"
            accessibilityLabel="Add context"
            style={[styles.round, { borderColor: c.border, borderWidth: 1 }]}
          >
            <Txt v="bodyMedium">@</Txt>
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Ask anything…"
            placeholderTextColor={c["text-dim"]}
            multiline
            autoFocus={!chatId}
            accessibilityLabel="Message"
            style={[
              styles.input,
              { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
            ]}
          />
          {streaming && !draft.trim() ? (
            <Pressable
              onPress={() =>
                chatId && void call("quickChat.cancel", { chatId, replyId: streaming.id })
              }
              accessibilityRole="button"
              accessibilityLabel="Stop"
              style={[styles.round, { backgroundColor: c.text }]}
            >
              <StopGlyph color={c["bg-page"]} />
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void send()}
              disabled={!online || sending || !draft.trim() || !selected}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={[
                styles.round,
                {
                  backgroundColor: c.primary,
                  opacity: online && draft.trim() && selected ? 1 : 0.45,
                },
              ]}
            >
              <Icon name="send" color={c["text-on-primary"]} size={20} stroke={2} />
            </Pressable>
          )}
        </View>
        <Pressable
          onPress={chooseConnection}
          onLongPress={chooseModel}
          accessibilityRole="button"
          accessibilityLabel="Connection and model"
          accessibilityHint="Tap to change the connection. Long press to change the model."
          style={styles.billing}
        >
          <Txt v="meta" tone="muted" lines={2}>
            {selected
              ? `${selection?.model} · ${billingLabel({ ...selected, hostName: selected.host.name })}`
              : connections?.length
                ? `No usable connection (${connections
                    .map((row) => connectionStatus[row.status])
                    .join(", ")})`
                : "No connection yet. Your draft is kept."}
          </Txt>
        </Pressable>
        {selected ? (
          <Button label="Change model" kind="plain" onPress={() => chooseModel()} />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function QuickRow({
  message,
  onAnswer,
}: {
  message: QuickMessage;
  onAnswer(requestId: string, decision: "allow" | "always" | "deny", optionId?: string): void;
}) {
  const { c } = useTheme();
  if (message.role === "user")
    return (
      <View style={[styles.user, { backgroundColor: c["bg-raised"] }]}>
        <Txt>{message.text}</Txt>
        {message.context.length ? (
          <Txt v="meta" tone="muted">
            Context used: {message.context.map((ref) => ref.path ?? ref.label).join(", ")}
          </Txt>
        ) : null}
      </View>
    );
  return (
    <View style={styles.reply}>
      {message.text ? (
        <Markdown value={message.text} />
      ) : message.status === "streaming" ? (
        <Txt tone="muted">Thinking…</Txt>
      ) : null}
      {message.tools?.length ? (
        <Txt v="meta" tone="muted">
          {toolSummary(message.tools)}
        </Txt>
      ) : null}
      {message.requests?.map((request) =>
        request.state === "pending" ? (
          <View
            key={request.id}
            style={[styles.request, { backgroundColor: c["bg-raised"] }]}
            accessibilityLabel="Request waiting for you"
          >
            <Txt>{request.title}</Txt>
            {request.toolName ? (
              <Txt v="meta" tone="muted">
                Tool: {toolName(request.toolName)}
              </Txt>
            ) : null}
            {request.detail ? (
              <Txt v="meta" tone="muted">
                {request.detail}
              </Txt>
            ) : null}
            <View style={styles.actions}>
              {request.kind === "question" ? (
                request.options?.map((option) => (
                  <Button
                    key={option.id}
                    label={option.label}
                    onPress={() => onAnswer(request.id, "allow", option.id)}
                  />
                ))
              ) : (
                <>
                  <Button
                    label="Allow once"
                    kind="primary"
                    onPress={() => onAnswer(request.id, "allow")}
                  />
                  {request.toolName ? (
                    <Button label="Always allow" onPress={() => onAnswer(request.id, "always")} />
                  ) : null}
                </>
              )}
              <Button
                label={request.kind === "question" ? "Skip" : "Deny"}
                kind="plain"
                onPress={() => onAnswer(request.id, "deny")}
              />
            </View>
          </View>
        ) : (
          <Txt key={request.id} v="meta" tone="muted">
            {requestOutcome[request.state]}: {request.title}
          </Txt>
        ),
      )}
      <Txt v="meta" tone="muted">
        {replyLabel(message)}
        {message.fallbackFrom ? " · automatic fallback" : ""}
      </Txt>
      {outcomeText[message.status] ? (
        <Txt v="meta">
          {outcomeText[message.status]} {message.error?.message ?? ""}
        </Txt>
      ) : null}
    </View>
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
  title: { flex: 1, minWidth: 0 },
  body: { padding: 16, gap: 14, flexGrow: 1 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  user: { alignSelf: "flex-end", maxWidth: "85%", borderRadius: 16, padding: 12, gap: 4 },
  reply: { gap: 4 },
  request: { borderRadius: 12, padding: 12, gap: 6 },
  composer: {
    gap: 6,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
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
  billing: { minHeight: touch, justifyContent: "center" },
});
