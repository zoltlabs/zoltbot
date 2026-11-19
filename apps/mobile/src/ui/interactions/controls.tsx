import { Pressable, StyleSheet, View } from "react-native";
import { touch, useTheme } from "../../theme";
import { Icon } from "../icons";
import { Txt } from "../kit";

/** A checkbox with its label, the whole row tappable. */
export function CheckRow({
  label,
  note,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      accessibilityLabel={[label, note].filter(Boolean).join(", ")}
      style={({ pressed }) => [
        styles.check,
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.5 },
      ]}
    >
      <View
        style={[
          styles.box,
          { borderColor: checked ? c.accent : c["border-strong"] },
          checked && { backgroundColor: c.accent },
        ]}
      >
        {checked ? <Icon name="check" size={14} stroke={3} color={c["text-on-primary"]} /> : null}
      </View>
      <View style={styles.flex}>
        <Txt>{label}</Txt>
        {note ? (
          <Txt v="meta" tone="muted">
            {note}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
}

/** − N + with VoiceOver's adjustable swipe; the buttons stop at the bounds. */
export function Stepper({
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const step = (by: number) => {
    const next = Math.min(max, Math.max(min, value + by));
    if (next !== value) onChange(next);
  };
  const button = (by: -1 | 1) => {
    const off = disabled || (by < 0 ? value <= min : value >= max);
    return (
      <Pressable
        onPress={() => step(by)}
        disabled={off}
        // The group is one adjustable control for VoiceOver; the buttons serve touch.
        accessibilityElementsHidden
        importantForAccessibility="no"
        hitSlop={6}
        style={({ pressed }) => [
          styles.step,
          { borderColor: c["border-control"] },
          pressed && { backgroundColor: c["bg-active"] },
          off && { opacity: 0.4 },
        ]}
      >
        <Icon name={by < 0 ? "minus" : "plus"} size={16} stroke={2} color={c.text} />
      </Pressable>
    );
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value, text: String(value) }}
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(event) => step(event.nativeEvent.actionName === "increment" ? 1 : -1)}
      style={styles.stepper}
    >
      {button(-1)}
      <Txt v="bodyMedium" style={styles.value}>
        {String(value)}
      </Txt>
      {button(1)}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  check: { flexDirection: "row", alignItems: "flex-start", gap: 12, minHeight: touch },
  box: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 0,
  },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  step: {
    width: touch,
    height: touch,
    borderRadius: touch / 2,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  value: { minWidth: 24, textAlign: "center", fontWeight: "600" },
});
