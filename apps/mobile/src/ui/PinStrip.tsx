// C4: pinned messages under the chat header, as a horizontal row. A pin jumps to its message.
import { ScrollView, StyleSheet } from "react-native";
import type { TranscriptRow } from "../data/view";
import { touch, useTheme } from "../theme";
import { Button } from "./kit";

const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};

export function PinStrip({
  pins,
  onJump,
}: {
  pins: TranscriptRow[];
  onJump: (row: TranscriptRow) => void;
}) {
  const { c } = useTheme();
  if (!pins.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel="Pinned messages"
      style={[styles.strip, { borderBottomColor: c.border }]}
      contentContainerStyle={styles.content}
    >
      {pins.map((pin) => (
        <Button
          key={pin.id}
          kind="secondary"
          label={short(pin.text)}
          a11y={pin.text.replace(/\s+/g, " ").trim()}
          onPress={() => onJump(pin)}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth },
  content: { gap: 8, paddingHorizontal: 16, paddingVertical: 6, minHeight: touch },
});
