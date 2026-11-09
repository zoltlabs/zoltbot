import type { ReactNode } from "react";
import {
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { avatarHue } from "../data/view";
import { avatarColors, mono, type Tokens, touch, type as typeScale, useTheme } from "../theme";

type Variant = keyof typeof typeScale;
type Tone =
  | "text"
  | "secondary"
  | "muted"
  | "accent"
  | "attention"
  | "ok"
  | "warn"
  | "danger"
  | "onPrimary";
const toneColor = (c: Tokens, tone: Tone) =>
  ({
    text: c.text,
    secondary: c["text-secondary"],
    muted: c["text-muted"],
    accent: c["accent-text"],
    attention: c.attention,
    ok: c.ok,
    warn: c.warn,
    danger: c.danger,
    onPrimary: c["text-on-primary"],
  })[tone];

export function Txt({
  v = "body",
  tone = "text",
  style,
  children,
  lines,
  ...rest
}: {
  v?: Variant;
  tone?: Tone;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
  lines?: number;
  accessibilityRole?: "header" | "text";
}) {
  const { c } = useTheme();
  return (
    <Text
      style={[typeScale[v] as TextStyle, { color: toneColor(c, tone) }, style]}
      numberOfLines={lines}
      {...rest}
    >
      {children}
    </Text>
  );
}

export function Section({
  title,
  count,
  right,
}: {
  title: string;
  count?: number;
  right?: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Txt v="section" accessibilityRole="header">
        {title}
        {count !== undefined ? <Txt v="bodyMedium" tone="muted">{`  ${count}`}</Txt> : null}
      </Txt>
      {right}
    </View>
  );
}

/** A raised card. `attention` rings it in the one warm color, for things that need the person. */
export function Card({
  children,
  attention,
  label,
  style,
}: {
  children: ReactNode;
  attention?: boolean;
  label?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { c } = useTheme();
  return (
    <View
      accessibilityLabel={label}
      style={[
        styles.card,
        { backgroundColor: c["bg-raised"], borderColor: attention ? c.attention : c.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Rows in one rounded group with hairlines between them. */
export function Group({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return (
    <View style={[styles.group, { backgroundColor: c["bg-raised"], borderColor: c.border }]}>
      {children}
    </View>
  );
}

export function Row({
  title,
  meta,
  left,
  right,
  onPress,
  last,
  label,
  mono,
  checked,
  disabled,
}: {
  title: string;
  meta?: string;
  left?: ReactNode;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  label?: string;
  mono?: boolean;
  /** Set for a row that toggles a switch, so VoiceOver reads it as one. */
  checked?: boolean;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const content = (
    <>
      {left}
      <View style={styles.rowText}>
        <Txt v="bodyMedium" lines={1}>
          {title}
        </Txt>
        {meta ? (
          <Txt v="meta" tone="muted" lines={1} style={mono ? styles.mono : undefined}>
            {meta}
          </Txt>
        ) : null}
      </View>
      {right}
    </>
  );
  const style = [
    styles.row,
    !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  ];
  if (!onPress) return <View style={style}>{content}</View>;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={checked === undefined ? "button" : "switch"}
      accessibilityState={{
        disabled: Boolean(disabled),
        ...(checked === undefined ? {} : { checked }),
      }}
      accessibilityLabel={label ?? [title, meta].filter(Boolean).join(", ")}
      style={({ pressed }) => [...style, pressed && { backgroundColor: c["bg-active"] }]}
    >
      {content}
    </Pressable>
  );
}

export type ChipTone = "attention" | "accent" | "ok" | "neutral" | "danger";
export function Chip({
  label,
  tone = "neutral",
  dot,
}: {
  label: string;
  tone?: ChipTone;
  dot?: boolean;
}) {
  const { c } = useTheme();
  const colors: Record<ChipTone, [string, string]> = {
    attention: [c["attention-soft"], c.attention],
    accent: [c["accent-soft"], c["accent-text"]],
    ok: [c["ok-soft"], c.ok],
    danger: [c["danger-soft"], c.danger],
    neutral: [c["bg-sunken"], c["text-secondary"]],
  };
  const [bg, fg] = colors[tone];
  return (
    <View
      style={[
        styles.chip,
        { backgroundColor: bg },
        tone === "neutral" && { borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
      ]}
    >
      {dot ? <View style={[styles.chipDot, { backgroundColor: fg }]} /> : null}
      <Txt v="chip" style={{ color: fg }}>
        {label}
      </Txt>
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = "secondary",
  disabled,
  a11y,
  style,
  icon,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "plain";
  disabled?: boolean;
  a11y?: string;
  style?: StyleProp<ViewStyle>;
  icon?: ReactNode;
}) {
  const { c } = useTheme();
  const look =
    kind === "primary"
      ? { backgroundColor: c.primary, borderColor: c.primary }
      : kind === "secondary"
        ? { backgroundColor: c["bg-raised"], borderColor: c["border-strong"] }
        : { backgroundColor: "transparent", borderColor: "transparent" };
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.button,
        look,
        pressed && { opacity: 0.7 },
        disabled && { opacity: 0.45 },
        style,
      ]}
    >
      {icon}
      <Txt
        v="bodyMedium"
        tone={kind === "primary" ? "onPrimary" : kind === "plain" ? "accent" : "text"}
        style={kind === "primary" ? styles.strong : undefined}
      >
        {label}
      </Txt>
    </Pressable>
  );
}

/** The character avatar: a hue body with a dark screen face and two eyes. */
export function Avatar({ id, size = 32 }: { id: string; size?: number }) {
  const { c } = useTheme();
  const colors = avatarColors(c, avatarHue(id));
  const inset = Math.round(size * 0.16);
  const eye = { width: Math.max(2, size * 0.09), height: size * 0.22, borderRadius: 2 };
  return (
    <View
      accessible={false}
      style={{ width: size, height: size, borderRadius: size * 0.28, backgroundColor: colors.body }}
    >
      <View
        style={{
          position: "absolute",
          top: inset,
          left: inset,
          right: inset,
          bottom: inset,
          borderRadius: size * 0.18,
          backgroundColor: colors.screen,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: size * 0.15,
        }}
      >
        <View style={[eye, { backgroundColor: colors.eye }]} />
        <View style={[eye, { backgroundColor: colors.eye }]} />
      </View>
    </View>
  );
}

/** Two or three choices in a sunken track; the chosen one is raised. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={[styles.segments, { backgroundColor: c["bg-sunken"], borderColor: c.border }]}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: Boolean(disabled) }}
            disabled={disabled}
            accessibilityLabel={option.label}
            onPress={() => onChange(option.value)}
            hitSlop={3}
            style={[
              styles.segment,
              on && { backgroundColor: c["bg-raised"], borderColor: c.border, borderWidth: 1 },
            ]}
          >
            <Txt v="bodyMedium" tone={on ? "text" : "secondary"}>
              {option.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

export const styles = StyleSheet.create({
  section: {
    marginTop: 14,
    marginHorizontal: 4,
    marginBottom: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 24,
  },
  card: { padding: 16, borderRadius: 16, borderWidth: 1, gap: 10 },
  group: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  row: {
    minHeight: touch + 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  mono: { fontFamily: mono, fontSize: 11 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  button: {
    minHeight: touch,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
  },
  strong: { fontWeight: "600" },
  segments: { flexDirection: "row", padding: 3, borderRadius: 12, borderWidth: 1, gap: 2 },
  segment: {
    flex: 1,
    minHeight: touch,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
