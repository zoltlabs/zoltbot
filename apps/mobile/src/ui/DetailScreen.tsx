import type { ReactNode } from "react";
import { useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { touch, type as typeScale, useTheme } from "../theme";
import { BackBar, OfflineBanner } from "./chrome";
import { Button, Txt } from "./kit";

/** Full-width, scrollable details keep forms and results above the phone keyboard. */
export function DetailScreen({ title, children }: { title: string; children: ReactNode }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: c["bg-page"], paddingTop: insets.top }}
    >
      <BackBar label="chat" />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16), gap: 16 }}
      >
        <Txt v="largeTitle" accessibilityRole="header">
          {title}
        </Txt>
        <OfflineBanner />
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function Field({
  label,
  value,
  onChange,
  disabled,
  multiline,
  numeric,
  hint,
  maxLength,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  multiline?: boolean;
  numeric?: boolean;
  hint?: string;
  maxLength?: number;
}) {
  const { c } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Txt v="bodyMedium">{label}</Txt>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        multiline={multiline}
        keyboardType={numeric ? "number-pad" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={maxLength}
        style={[
          typeScale.body,
          {
            color: c.text,
            backgroundColor: c["bg-raised"],
            borderColor: c["border-control"],
            borderWidth: 1,
            borderRadius: 12,
            padding: 12,
            minHeight: touch,
            textAlignVertical: "top",
          },
        ]}
      />
      {hint ? <Txt tone="secondary">{hint}</Txt> : null}
    </View>
  );
}

/** Expand inline rather than crowding long choices into a segmented control or alert. */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Txt v="bodyMedium">{label}</Txt>
      <Button
        label={`${expanded ? "Hide choices" : "Choose"}: ${options.find((o) => o.value === value)?.label ?? "Not selected"}`}
        disabled={disabled}
        expanded={expanded}
        onPress={() => setExpanded(!expanded)}
      />
      {expanded ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: 8 }}>
          {options.map((option) => (
            <ChoiceOption
              key={option.value}
              label={option.label}
              selected={option.value === value}
              disabled={disabled}
              onPress={() => {
                onChange(option.value);
                setExpanded(false);
              }}
            />
          ))}
          {!options.length ? (
            <Txt tone="secondary">
              No tracked sources yet. Choose another condition or start the work first.
            </Txt>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ChoiceOption({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: touch,
        padding: 12,
        borderWidth: 1,
        borderColor: c["border-control"],
        borderRadius: 12,
        backgroundColor: c["bg-raised"],
      }}
    >
      <Txt>{selected ? `Selected · ${label}` : label}</Txt>
    </Pressable>
  );
}
