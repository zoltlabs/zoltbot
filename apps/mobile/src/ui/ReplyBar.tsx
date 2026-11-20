// C6: the message being replied to, shown above the composer until it is sent or cancelled.
import { splitQuote } from "@zoltbot/protocol";
import { Pressable, StyleSheet, View } from "react-native";
import type { TranscriptRow } from "../data/view";
import { touch, useTheme } from "../theme";
import { Icon } from "./icons";
import { Txt } from "./kit";

export function ReplyBar({
  row,
  name,
  onCancel,
}: {
  row: TranscriptRow;
  name: string;
  onCancel: () => void;
}) {
  const { c } = useTheme();
  const to = row.kind === "user" ? "your message" : name;
  const reply = splitQuote(row.text);
  const words = reply ? reply.rest || reply.quote : row.text;
  const spoken = words.length > 150 ? `${words.slice(0, 149)}…` : words;
  return (
    <View style={[styles.bar, { borderLeftColor: c.accent }]}>
      <View style={styles.words} accessible accessibilityLabel={`Replying to ${to}: ${spoken}`}>
        <Txt v="meta" tone="accent">
          Replying to {to}
        </Txt>
        <Txt v="meta" tone="secondary" lines={2}>
          {words}
        </Txt>
      </View>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel reply"
        hitSlop={8}
        style={styles.close}
      >
        <Icon name="close" size={18} color={c["text-secondary"]} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, borderLeftWidth: 2, paddingLeft: 10 },
  words: { flex: 1, gap: 2 },
  close: { minWidth: touch, minHeight: touch, alignItems: "center", justifyContent: "center" },
});
