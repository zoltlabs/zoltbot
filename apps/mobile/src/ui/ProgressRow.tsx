// C10: a progress note: a small bubble in the agent's colour, with no avatar.
import { StyleSheet, View } from "react-native";
import type { TranscriptRow } from "../data/timeline";
import { useTheme } from "../theme";
import { useBotColor } from "./BotAvatar";
import { Txt } from "./kit";

export function ProgressRow({ row }: { row: TranscriptRow }) {
  const { c } = useTheme();
  const color = useBotColor(row.progress?.threadId ?? "", row.progress?.zolt === true);
  return (
    <View
      accessible
      accessibilityLabel={`Progress note: ${row.text}`}
      style={[styles.note, { backgroundColor: c["bg-sunken"], borderColor: `${color}55` }]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Txt v="meta" tone="secondary" style={styles.text}>
        {row.text}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    flexDirection: "row",
    alignItems: "baseline",
    alignSelf: "flex-start",
    maxWidth: "88%",
    gap: 8,
    marginVertical: 2,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { flexShrink: 1 },
});
