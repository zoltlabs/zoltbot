import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { touch, useTheme } from "../theme";
import { Button, Txt } from "../ui/kit";
import { StateLabel } from "./graphics";
import { type Initiative, type State, waiting } from "./model";

export function OrderButton({
  label,
  onPress,
  attention = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  attention?: boolean;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  if (!attention)
    return (
      <Button label={label} onPress={onPress} disabled={disabled} style={{ borderRadius: 2 }} />
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        {
          backgroundColor: c.attention,
          borderColor: c.attention,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Txt v="bodyMedium" style={{ color: c["bg-frame"], textAlign: "center", flexShrink: 1 }}>
        {label}
      </Txt>
    </Pressable>
  );
}
export function Panel({
  children,
  attention = false,
}: {
  children: ReactNode;
  attention?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View
      style={[
        s.panel,
        { backgroundColor: c["bg-raised"], borderColor: attention ? c.attention : c.border },
      ]}
    >
      {children}
    </View>
  );
}
export function Progress({
  initiative,
  compact = false,
}: {
  initiative: Initiative;
  compact?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View
      style={{ gap: 4 }}
      accessible
      accessibilityLabel={`${initiative.done} of ${initiative.total} tasks done`}
    >
      {!compact ? (
        <Txt v="code">
          {initiative.done}/{initiative.total} tasks
        </Txt>
      ) : null}
      <View style={{ height: 3, backgroundColor: c["bg-frame"] }}>
        <View
          style={{
            height: 3,
            width: `${(100 * initiative.done) / initiative.total}%`,
            backgroundColor: waiting(initiative) ? c.attention : c["accent-text"],
          }}
        />
      </View>
    </View>
  );
}
export function Health({ initiative }: { initiative: Initiative }) {
  const count = waiting(initiative);
  const state: State = count
    ? "needs_you"
    : initiative.checks.length
      ? "problem"
      : initiative.done / initiative.total > 0.9
        ? "review"
        : "working";
  const label = count
    ? `${count} need you`
    : initiative.checks.length
      ? `${initiative.checks.length} checks failed`
      : state === "review"
        ? "Nearly done"
        : "Working";
  return <StateLabel state={state} label={label} />;
}
const s = StyleSheet.create({
  button: {
    minHeight: touch,
    minWidth: touch,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 2,
  },
  panel: { padding: 12, gap: 10, borderWidth: 1 },
});
