import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ChannelMember, ChannelPostView, ChannelRequestView } from "../../data/channels";
import { recipientLabel } from "../../data/channels";
import { touch, type as typography, useTheme } from "../../theme";
import { BotAvatar } from "../BotAvatar";
import { Txt } from "../kit";

export function LeadBadge() {
  const { c } = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: c["accent-soft"] }]}>
      <Text style={[styles.badgeText, { color: c["accent-text"] }]}>Lead</Text>
    </View>
  );
}

/** The state dot: filled while open or running, a ring when stopped, green when done. */
export function RequestDot({ state }: { state: ChannelRequestView["state"] }) {
  const { c } = useTheme();
  const look =
    state === "done"
      ? { backgroundColor: c.ok }
      : state === "stopped" || state === "archived"
        ? { borderWidth: 1.5, borderColor: c["text-muted"] }
        : { backgroundColor: c["accent-text"] };
  return <View style={[styles.dot, look]} />;
}

/** A small outlined pill for a request action. Its hit area still meets the touch size. */
export function PillButton({
  label,
  a11y,
  onPress,
  disabled,
  icon,
}: {
  label: string;
  a11y?: string;
  onPress: () => void;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.pill,
        { borderColor: c["border-strong"] },
        pressed && { backgroundColor: c["bg-active"] },
        disabled && { opacity: 0.45 },
      ]}
    >
      {icon}
      <Txt v="chip">{label}</Txt>
    </Pressable>
  );
}

/** Post text with each @mention of a member in the accent color. */
function MentionText({ text, members }: { text: string; members: readonly ChannelMember[] }) {
  const { c } = useTheme();
  const names = [...members].map((m) => m.name).sort((a, b) => b.length - a.length);
  if (!names.length) return <Txt>{text}</Txt>;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(@(?:${escaped.join("|")}))(?![\\p{L}\\p{N}_])`, "giu");
  const parts = text.split(pattern);
  return (
    <Txt selectable>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: split parts have no other identity
          <Text key={index} style={{ color: c["accent-text"], fontWeight: "500" }}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Txt>
  );
}

export function PostRow({
  post,
  members,
  leadThreadId,
}: {
  post: ChannelPostView;
  members: readonly ChannelMember[];
  leadThreadId: string;
}) {
  const { c } = useTheme();
  if (post.author.kind === "owner") {
    const to = recipientLabel(post.to);
    const meta = post.sending ? (to ? `${to} · Sending…` : "Sending…") : to;
    return (
      <View style={[styles.post, styles.own]}>
        <View style={[styles.bubble, { backgroundColor: c["bg-popover"] }]}>
          <MentionText text={post.text} members={members} />
        </View>
        {meta ? (
          <Txt v="meta" tone="muted">
            {meta}
          </Txt>
        ) : null}
      </View>
    );
  }
  const { threadId, name } = post.author;
  return (
    <View style={styles.post} accessible accessibilityLabel={`${name}: ${post.text}`}>
      <View style={styles.who}>
        <BotAvatar id={threadId} size={28} />
        <Txt v="section" style={styles.whoName}>
          {name}
        </Txt>
        {threadId === leadThreadId ? <LeadBadge /> : null}
      </View>
      <View style={styles.indent}>
        <MentionText text={post.text} members={members} />
      </View>
    </View>
  );
}

export function Notice({ text }: { text: string }) {
  return (
    <Txt v="meta" tone="muted" style={styles.notice}>
      {text}
    </Txt>
  );
}

/** A round icon button in the header, as in the mockups. */
export function HeaderButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.headerButton,
        { backgroundColor: c["bg-raised"], borderColor: c.border },
        pressed && { opacity: 0.7 },
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { ...typography.tab, fontWeight: "600" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pill: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  grow: { flex: 1, minWidth: 0 },
  post: { gap: 6 },
  own: { alignItems: "flex-end" },
  bubble: {
    maxWidth: "80%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 6,
  },
  who: { flexDirection: "row", alignItems: "center", gap: 8 },
  whoName: { fontSize: 14 },
  indent: { paddingLeft: 36 },
  notice: { textAlign: "center", paddingHorizontal: 24 },
  headerButton: {
    width: touch,
    height: touch,
    borderRadius: touch / 2,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
