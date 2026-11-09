import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { since } from "../data/view";
import { useClient, useLink } from "../state/link";
import { touch, useTheme } from "../theme";
import { Icon } from "./icons";
import { Txt } from "./kit";

/** "Example MacBook Pro · Connected", with a dot that turns grey when the link is down. */
export function StatusLine() {
  const { c } = useTheme();
  const name = useLink((state) => state.macName) || "Your Mac";
  const status = useClient((state) => state.status);
  const label =
    status === "online"
      ? "Connected"
      : status === "connecting"
        ? "Connecting"
        : status === "pairing"
          ? "Waiting for Allow"
          : "Offline";
  return (
    <View style={styles.status} accessible accessibilityLabel={`${name}, ${label}`}>
      <View
        style={[styles.dot, { backgroundColor: status === "online" ? c.ok : c["text-muted"] }]}
      />
      <Txt v="meta" tone="muted" lines={1}>
        {`${name} · ${label}`}
      </Txt>
    </View>
  );
}

/** Shown under the title whenever actions cannot reach the Mac. Lists keep the last snapshot. */
export function OfflineBanner() {
  const { c } = useTheme();
  const { status, lastSeenAt, error } = useClient((state) => state);
  if (status === "online" || status === "connecting" || status === "pairing") return null;
  const seen = lastSeenAt ? ` Last seen ${since(lastSeenAt)}.` : "";
  const lead = status === "offline" && !error ? "You are offline." : "Your Mac is offline.";
  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: c["warn-soft"] }]}>
      <Txt v="body">
        <Txt v="body" tone="warn" style={styles.strong}>
          {status === "offline" && error ? error : lead}
        </Txt>
        {`${seen} You are seeing saved data, and actions wait until your Mac is back.`}
      </Txt>
    </View>
  );
}

/** A tab root: status line, large title and a scrolling body. */
export function TabScreen({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"] }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <StatusLine />
        <View style={styles.titleRow}>
          <Txt v="largeTitle" accessibilityRole="header">
            {title}
          </Txt>
          {right}
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <OfflineBanner />
        {children}
      </ScrollView>
    </View>
  );
}

/** A pushed screen: a back button with the parent's name, then content. */
export function BackBar({
  label,
  right,
  iconOnly,
}: {
  label: string;
  right?: ReactNode;
  iconOnly?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View style={styles.backBar}>
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        accessibilityRole="button"
        accessibilityLabel={`Back to ${label}`}
        style={styles.back}
        hitSlop={6}
      >
        <Icon name="back" color={c["accent-text"]} stroke={2} />
        {iconOnly ? null : (
          <Txt v="bodyMedium" tone="accent" style={styles.backText}>
            {label}
          </Txt>
        )}
      </Pressable>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

/** A round accent button for the one action a screen offers, like New task. */
export function RoundButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: Boolean(disabled) }}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: c.primary },
        disabled && { opacity: 0.45 },
        pressed && { opacity: 0.8 },
      ]}
    >
      <Icon name="plus" color={c["text-on-primary"]} size={20} stroke={2} />
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 12, gap: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  body: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  banner: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12 },
  strong: { fontWeight: "600" },
  backBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  right: { marginRight: 8 },
  back: {
    minHeight: touch,
    minWidth: touch,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingRight: 8,
  },
  backText: { fontSize: 17 },
  round: {
    width: touch,
    height: touch,
    borderRadius: touch / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
