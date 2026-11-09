import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { writeError } from "../../data/manage";
import { deliveryLabel } from "../../data/timeline";
import type { Row as Entity } from "../../data/transport";
import { chats, runningTurn, text, transcript } from "../../data/view";
import { attempts, newId, owner } from "../../state/actions";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { sans, useTheme } from "../../theme";
import { OfflineBanner } from "../../ui/chrome";
import { Button, Group, Row, Section, Segmented, Txt } from "../../ui/kit";

/**
 * Send a message from this chat to another one, such as passing an agent's answer along. It
 * arrives as if typed there: queued for the next turn, or steering a running one where the agent
 * allows it.
 */
export default function SendToChat() {
  const { id, item } = useLocalSearchParams<{ id: string; item?: string }>();
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const source = transcript(snapshot, id).find((row) => row.id === item);
  const [draft, setDraft] = useState(source?.text ?? "");
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<"steer" | "queue">("queue");
  const [sent, setSent] = useState<{ threadId: string; itemId: string }>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  // A retry after a lost reply keeps the message id, so the Mac never delivers it twice.
  const attempt = useRef(newId("msg"));

  const options = chats(snapshot)
    .filter((row) => row.thread.id !== id)
    .slice(0, 30);
  const thread = options.find((row) => row.thread.id === target)?.thread;
  const session = snapshot.entities.session?.find(
    (row) => row.threadId === target && row.state !== "closed",
  );
  const canSteer =
    !!runningTurn(snapshot, target) &&
    (session?.capabilities as Entity | undefined)?.steer === "native";

  const send = async () => {
    const client = useLink.getState().client?.getState();
    if (!client || !thread) return;
    const messageId = attempt.current;
    setWorking(true);
    setError("");
    try {
      const result = (await attempts.run(
        `message:${messageId}`,
        {
          message: {
            id: messageId,
            thread: target,
            fromThread: id,
            from: owner,
            to: [{ kind: "agent", id: text(thread.agentId) }],
            kind: "message",
            expectsReply: false,
            priority: "normal",
            delivery: canSteer && mode === "steer" ? "steer" : "next_turn",
            root: messageId,
            hops: 0,
            ttlHops: 6,
            origin: "human",
            body: [{ type: "text", text: draft.trim() }],
            createdAt: new Date().toISOString(),
          },
        },
        (params, commandId) => client.call("message.send", params, commandId),
      )) as { deliveries?: { id: string }[] };
      setSent({ threadId: target, itemId: text(result.deliveries?.[0]?.id) });
    } catch (cause) {
      // A definite refusal is forgotten by attempts; the next try is a new message.
      if (!attempts.pending(`message:${messageId}`)) attempt.current = newId("msg");
      setError(writeError(cause));
    } finally {
      setWorking(false);
    }
  };

  if (sent) {
    const delivered = snapshot.entities.item?.find(
      (row) => row.id === sent.itemId && row.threadId === sent.threadId,
    );
    const status = delivered
      ? (deliveryLabel((delivered.body ?? {}) as Entity) ?? "Delivered")
      : "Sent";
    return (
      <View style={[styles.page, styles.done, { backgroundColor: c["bg-page"] }]}>
        <Txt v="cardTitle" accessibilityRole="header">
          {`Sent to ${text(thread?.title) || "the chat"}`}
        </Txt>
        <View accessibilityLiveRegion="polite">
          <Txt tone="muted">{status}</Txt>
        </View>
        <Button
          label="Open chat"
          onPress={() => {
            router.dismiss();
            router.push(`/chat/${sent.threadId}`);
          }}
        />
        <Button kind="plain" label="Done" onPress={() => router.back()} />
      </View>
    );
  }
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={styles.page}
    >
      <View style={styles.head}>
        <Button kind="plain" label="Cancel" disabled={working} onPress={() => router.back()} />
        <Txt v="cardTitle" accessibilityRole="header">
          Send to chat
        </Txt>
        <Button
          kind="plain"
          label={working ? "Sending…" : "Send"}
          disabled={working || !online || !thread || !draft.trim()}
          onPress={() => void send()}
        />
      </View>
      <OfflineBanner />
      <TextInput
        value={draft}
        onChangeText={setDraft}
        multiline
        editable={!working}
        maxLength={2000}
        accessibilityLabel="Message"
        style={[
          styles.input,
          { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
        ]}
      />
      {canSteer ? (
        <Segmented<"steer" | "queue">
          label="Delivery"
          value={mode}
          onChange={setMode}
          disabled={working}
          options={[
            { value: "steer", label: "Steer now" },
            { value: "queue", label: "After this turn" },
          ]}
        />
      ) : null}
      {error ? <Txt tone="danger">{error}</Txt> : null}
      <Section title="To" />
      <Group>
        {options.map((row, index) => (
          <Row
            key={text(row.thread.id)}
            title={text(row.thread.title) || "Chat"}
            {...(row.working ? { meta: "Working" } : {})}
            checked={target === row.thread.id}
            disabled={working}
            onPress={() => setTarget(text(row.thread.id))}
            last={index === options.length - 1}
          />
        ))}
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12 },
  done: { flex: 1 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input: {
    fontFamily: sans,
    fontSize: 15,
    minHeight: 120,
    maxHeight: 240,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    textAlignVertical: "top",
  },
});
