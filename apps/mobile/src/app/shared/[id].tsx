import { terms } from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Image, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { draftDestination, type SharedDraft, shareRecipients } from "../../data/sharing";
import { deliverSharedDraft, SharedDraftSentError } from "../../data/sharing-delivery";
import { useClient, useLink, useSnapshot } from "../../state/link";
import {
  donateBotConversation,
  markSharedDraftSent,
  removeSharedDraft,
  updateSharedDraft,
  useSharing,
} from "../../state/sharing";
import { touch, useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Button, Group, Row, Txt } from "../../ui/kit";

function ReviewDraft({ draft }: { draft: SharedDraft }) {
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const macId = useLink((state) => state.mac?.macId);
  const online = useClient(
    (state) => state.status === "online" && state.loaded && state.kind !== "fake",
  );
  const recipients = shareRecipients(snapshot, macId ?? "").filter(
    (row) => row.macId === draft.macId,
  );
  const [recipientId, setRecipientId] = useState(draft.recipientId);
  const [message, setMessage] = useState(draft.text);
  const [busy, setBusy] = useState(false);
  const [sentThread, setSentThread] = useState(draft.sentThreadId ?? "");
  const locked = useRef(false);
  const destination = draftDestination(draft, recipients, recipientId);
  const error = (title: string, value: unknown) =>
    Alert.alert(title, value instanceof Error ? value.message : String(value));
  const save = async () => {
    if (locked.current || sentThread) return;
    locked.current = true;
    setBusy(true);
    try {
      await updateSharedDraft(draft.id, recipientId, message);
    } catch (value) {
      error("Could not save changes", value);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const send = async () => {
    if (locked.current || sentThread || !destination || !online) return;
    locked.current = true;
    setBusy(true);
    try {
      const threadId = await deliverSharedDraft(draft, message, {
        save: () => updateSharedDraft(draft.id, recipientId, message),
        destination: () => {
          const { client, mac } = useLink.getState();
          const state = client?.getState();
          if (!mac || state?.status !== "online" || !state.loaded || state.kind === "fake") return;
          return draftDestination(draft, shareRecipients(state.snapshot, mac.macId), recipientId);
        },
        send: (threadId, input) => {
          const client = useLink.getState().client;
          if (!client) return Promise.reject(new Error("Reconnect to your Mac."));
          return client.getState().call("turn.send", { threadId, input, mode: "queue" });
        },
        acknowledged: (threadId) => {
          setSentThread(threadId);
          void donateBotConversation(threadId).catch(() => undefined);
        },
        markSent: (threadId) => markSharedDraftSent(draft.id, threadId),
        remove: () => removeSharedDraft(draft.id),
      });
      router.replace(`/chat/${threadId}`);
    } catch (value) {
      if (value instanceof SharedDraftSentError) {
        setSentThread(value.threadId);
        error(
          "Message sent; draft cleanup failed",
          "The message was sent. Remove this draft without sending it again.",
        );
      } else
        Alert.alert(
          "Share was not confirmed",
          `${value instanceof Error ? value.message : String(value)}\n\nYour original draft is still available. If the connection dropped while sending, check the conversation before retrying.`,
        );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const discard = () =>
    Alert.alert(
      sentThread ? "Remove sent draft?" : "Discard shared draft?",
      "This removes the draft from this iPhone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            if (locked.current) return;
            locked.current = true;
            setBusy(true);
            void removeSharedDraft(draft.id)
              .then(() => router.replace("/shared"))
              .catch((value: unknown) => {
                error("Could not remove draft", value);
              })
              .finally(() => {
                locked.current = false;
                setBusy(false);
              });
          },
        },
      ],
    );
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 20, gap: 16 }}
    >
      <Txt v="cardTitle" accessibilityRole="header">
        {sentThread ? "Message sent" : "Review shared draft"}
      </Txt>
      <OfflineBanner />
      {!recipients.length ? (
        <Txt tone="muted">
          Connect to the original Mac with an active {terms.chat.one} or {terms.manager.one} to send
          this draft.
        </Txt>
      ) : null}
      {!destination && recipients.length ? (
        <Txt tone="muted">The original bot is unavailable. Choose another destination.</Txt>
      ) : null}
      <Group>
        {recipients.map((recipient, index) => (
          <Row
            key={recipient.id}
            title={recipient.name}
            meta={recipient.id === recipientId ? "Selected" : "Tap to select"}
            disabled={busy || Boolean(sentThread)}
            last={index === recipients.length - 1}
            onPress={() => setRecipientId(recipient.id)}
          />
        ))}
      </Group>
      <TextInput
        accessibilityLabel="Shared message"
        multiline
        value={message}
        onChangeText={setMessage}
        editable={!busy && !sentThread}
        style={{
          minHeight: 140,
          padding: 12,
          borderWidth: 1,
          borderRadius: 12,
          borderColor: c.border,
          color: c.text,
          backgroundColor: c["bg-raised"],
          fontSize: 16,
          textAlignVertical: "top",
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {draft.images.map((photo, index) => (
          <Image
            // biome-ignore lint/suspicious/noArrayIndexKey: Saved photos are immutable and never reordered.
            key={`${draft.id}-${index}`}
            accessibilityLabel={`Shared photo ${index + 1}`}
            source={{ uri: `data:image/jpeg;base64,${photo.base64}` }}
            style={{ width: 96, height: 96, borderRadius: 8 }}
          />
        ))}
      </View>
      <Txt tone="muted">
        {sentThread
          ? "This draft has already been sent."
          : "Sending queues a message for the selected bot. Unsaved edits are lost when you leave this screen."}
      </Txt>
      {sentThread ? (
        <Button label="Open conversation" onPress={() => router.replace(`/chat/${sentThread}`)} />
      ) : (
        <>
          <Button
            label="Save changes"
            disabled={busy || !destination}
            onPress={() => void save()}
          />
          <Button
            label={busy ? "Working…" : "Send"}
            disabled={busy || !online || !destination || (!message.trim() && !draft.images.length)}
            onPress={() => void send()}
          />
        </>
      )}
      <Button
        kind="plain"
        label={sentThread ? "Remove sent draft" : "Discard draft"}
        disabled={busy}
        onPress={discard}
        style={{ minHeight: touch }}
      />
    </ScrollView>
  );
}

export default function SharedReview() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const draft = useSharing((state) => state.drafts.find((row) => row.id === id));
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c["bg-page"],
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
      }}
    >
      <BackBar label="Shared drafts" />
      {draft ? (
        <ReviewDraft key={draft.id} draft={draft} />
      ) : (
        <Txt style={{ padding: 20 }}>This draft has been sent or removed.</Txt>
      )}
    </View>
  );
}
