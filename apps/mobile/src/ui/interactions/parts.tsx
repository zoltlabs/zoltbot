import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { diffView } from "../../data/interactions";
import { mono, sans, touch, useTheme } from "../../theme";
import { Icon } from "../icons";
import { Txt } from "../kit";

/** A labelled text input for feedback, "Other" answers and form fields. */
export function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  secure,
  numeric,
  disabled,
  autoFocus,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  secure?: boolean;
  numeric?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  hint?: string;
}) {
  const { c } = useTheme();
  return (
    <View style={styles.field}>
      <Txt v="meta" tone="secondary">
        {label}
      </Txt>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c["text-dim"]}
        multiline={multiline && !secure}
        secureTextEntry={secure}
        autoCorrect={!secure}
        autoCapitalize={secure ? "none" : "sentences"}
        autoComplete={secure ? "off" : undefined}
        textContentType={secure ? "oneTimeCode" : undefined}
        keyboardType={numeric ? "numbers-and-punctuation" : "default"}
        editable={!disabled}
        autoFocus={autoFocus}
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={[
          styles.input,
          multiline && !secure && styles.multiline,
          { color: c.text, borderColor: c["border-control"], backgroundColor: c["bg-page"] },
          disabled && { opacity: 0.6 },
        ]}
      />
      {hint ? (
        <Txt v="meta" tone="muted">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

const maxLines = 300;
/** One file's diff, collapsed to its path and +N −M until tapped. */
export function DiffBlock({
  diff,
  initiallyOpen,
}: {
  diff: { path: string; before?: string; after?: string; patch?: string };
  initiallyOpen?: boolean;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(Boolean(initiallyOpen));
  const view = diffView(diff);
  const [limit, setLimit] = useState(maxLines);
  const colors = {
    add: { color: c.ok, backgroundColor: c["ok-soft"] },
    del: { color: c.danger, backgroundColor: c["danger-soft"] },
    hunk: { color: c["text-muted"] },
    context: { color: c["text-secondary"] },
  };
  return (
    <View style={[styles.diff, { borderColor: c.border, backgroundColor: c["bg-sunken"] }]}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${view.path}, ${view.added} lines added, ${view.removed} removed`}
        accessibilityHint={open ? "Hides the diff" : "Shows the diff"}
        style={styles.diffHead}
      >
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevron" size={14} color={c["text-muted"]} stroke={2} />
        </View>
        <Txt v="meta" style={[styles.flex, { fontFamily: mono }]}>
          {view.path}
        </Txt>
        <Txt v="meta" style={{ fontFamily: mono, color: c.ok }}>{`+${view.added}`}</Txt>
        <Txt v="meta" style={{ fontFamily: mono, color: c.danger }}>{`−${view.removed}`}</Txt>
      </Pressable>
      {open ? (
        <ScrollView horizontal style={styles.diffBody} contentContainerStyle={styles.diffLines}>
          <View>
            {view.lines.slice(0, limit).map((line, index) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: diff lines repeat, order is identity
                key={index}
                selectable
                style={[styles.diffLine, { fontFamily: mono }, colors[line.type]]}
              >
                {line.text || " "}
              </Text>
            ))}
            {view.lines.length > limit ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Show more diff lines, ${view.lines.length - limit} remaining`}
                onPress={() => setLimit((current) => current + maxLines)}
                style={{ minHeight: touch, justifyContent: "center", paddingHorizontal: 10 }}
              >
                <Txt
                  v="meta"
                  tone="secondary"
                >{`Show more lines (${view.lines.length - limit} remaining)`}</Txt>
              </Pressable>
            ) : null}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

/** A large tappable choice row with radio or checkbox semantics. */
export function OptionRow({
  label,
  description,
  recommended,
  selected,
  multi,
  disabled,
  onPress,
}: {
  label: string;
  description?: string | undefined;
  recommended?: boolean | undefined;
  selected: boolean;
  multi?: boolean | undefined;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { c } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const long = (description?.length ?? 0) > 160;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={long ? () => setExpanded(!expanded) : undefined}
      disabled={disabled}
      accessibilityRole={multi ? "checkbox" : "radio"}
      accessibilityState={{ checked: selected, disabled: Boolean(disabled) }}
      accessibilityLabel={[label, recommended ? "Recommended" : "", description ?? ""]
        .filter(Boolean)
        .join(", ")}
      style={({ pressed }) => [
        styles.option,
        {
          borderColor: selected ? c.accent : c.border,
          backgroundColor: selected ? c["accent-soft"] : c["bg-page"],
        },
        pressed && { opacity: 0.75 },
        disabled && { opacity: 0.5 },
      ]}
    >
      <View
        style={[
          multi ? styles.check : styles.radio,
          { borderColor: selected ? c.accent : c["border-strong"] },
          selected && multi && { backgroundColor: c.accent },
        ]}
      >
        {selected ? (
          multi ? (
            <Icon name="check" size={12} stroke={3} color={c["text-on-primary"]} />
          ) : (
            <View style={[styles.dot, { backgroundColor: c.accent }]} />
          )
        ) : null}
      </View>
      <View style={styles.flex}>
        <View style={styles.optionHead}>
          <Txt v="bodyMedium" style={styles.flexShrink}>
            {label}
          </Txt>
          {recommended ? (
            <View style={[styles.badge, { backgroundColor: c["accent-soft"] }]}>
              <Txt v="meta" tone="accent">
                Recommended
              </Txt>
            </View>
          ) : null}
        </View>
        {description ? (
          <Txt v="meta" tone="muted" lines={long && !expanded ? 3 : undefined}>
            {description}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  field: { gap: 6 },
  input: {
    fontFamily: sans,
    minHeight: touch,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  multiline: { minHeight: 84, maxHeight: 160, textAlignVertical: "top" },
  diff: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
  diffHead: {
    minHeight: touch,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
  },
  diffBody: {},
  more: { paddingHorizontal: 10, paddingTop: 6 },
  diffLines: { paddingBottom: 8 },
  diffLine: { fontSize: 11, lineHeight: 16, paddingHorizontal: 10 },
  option: {
    minHeight: touch + 8,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  optionHead: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  badge: { paddingHorizontal: 6, borderRadius: 6 },
});
