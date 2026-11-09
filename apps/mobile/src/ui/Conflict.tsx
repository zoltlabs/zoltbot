import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme";
import { Button, Txt } from "./kit";

/**
 * A write that lost a race with another device: the Mac's value next to the phone's, so neither
 * is lost. "Save mine" retries against the Mac's new version.
 */
export function Conflict({
  mac,
  mine,
  busy,
  onKeep,
  onSave,
}: {
  mac: string;
  mine: string;
  busy?: boolean;
  onKeep: () => void;
  onSave: () => void;
}) {
  const { c } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[styles.card, { borderColor: c.attention, backgroundColor: c["attention-soft"] }]}
    >
      <Txt v="bodyMedium">Changed on your Mac</Txt>
      <View style={styles.pair}>
        <Txt v="meta" tone="muted">
          Mac
        </Txt>
        <Txt v="meta" style={styles.flex}>
          {mac}
        </Txt>
      </View>
      <View style={styles.pair}>
        <Txt v="meta" tone="muted">
          Yours
        </Txt>
        <Txt v="meta" style={styles.flex}>
          {mine}
        </Txt>
      </View>
      <View style={styles.actions}>
        <Button
          kind="secondary"
          label="Keep Mac's"
          disabled={busy}
          onPress={onKeep}
          style={styles.flex}
        />
        <Button label="Save mine" disabled={busy} onPress={onSave} style={styles.flex} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
  pair: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  actions: { flexDirection: "row", gap: 8, marginTop: 4 },
});
