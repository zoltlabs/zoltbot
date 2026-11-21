// C12: messages written while the Mac was unreachable. They send on their own once it is back.
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { unreachable } from "../data/outbox";
import { useLink } from "../state/link";
import { outbox, useOutbox } from "../state/outbox";
import { useTheme } from "../theme";
import { Button, Txt } from "./kit";

export function WaitingMessages({ threadId }: { threadId: string }) {
  const { c } = useTheme();
  const macId = useLink((state) => state.activeId);
  const messages = useOutbox((state) => state.messages).filter(
    (row) => row.threadId === threadId && (!row.macId || !macId || row.macId === macId),
  );
  const [busy, setBusy] = useState<string>();
  if (!messages.length) return null;
  const sendNow = async (id: string) => {
    setBusy(id);
    try {
      await outbox.sendNow(id);
    } catch (error) {
      Alert.alert(
        unreachable(error)
          ? "Your Mac isn’t reachable yet. The message sends when it’s back."
          : "Your Mac didn’t accept this message. Delete it, or copy it into a new one.",
      );
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      {messages.map((message) => (
        <View key={message.id} style={styles.mine}>
          <View
            style={[styles.bubble, { backgroundColor: c["bg-popover"] }]}
            accessibilityLabel={`You: ${message.text}. Waiting to send`}
          >
            <Txt selectable>{message.text}</Txt>
          </View>
          <View style={styles.row}>
            <Txt v="meta" tone="secondary">
              Waiting to send
            </Txt>
            <Button
              kind="plain"
              label="Send now"
              disabled={busy === message.id}
              onPress={() => void sendNow(message.id)}
            />
            <Button
              kind="plain"
              label="Delete"
              disabled={busy === message.id}
              onPress={() => void outbox.remove(message.id)}
            />
          </View>
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  mine: { alignItems: "flex-end", gap: 2 },
  bubble: {
    alignSelf: "flex-end",
    marginLeft: 56,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderBottomRightRadius: 6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
});
