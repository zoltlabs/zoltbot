import { channelPostLimit } from "@zoltbot/protocol";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import {
  type ChannelMember,
  insertMention,
  matchMembers,
  mentionAt,
  recipientLabel,
  recipientsFor,
} from "../../data/channels";
import { sans, touch, useTheme } from "../../theme";
import { BotAvatar } from "../BotAvatar";
import { Icon } from "../icons";
import { Txt } from "../kit";

/**
 * The channel's message box. It says who the message goes to: the lead, or the members it
 * @mentions. Typing @ lists the members above it.
 */
export function ChannelComposer({
  channelName,
  members,
  disabled,
  bottom,
  onSend,
}: {
  channelName: string;
  members: readonly ChannelMember[];
  disabled?: boolean;
  bottom: number;
  onSend: (text: string) => Promise<boolean>;
}) {
  const { c } = useTheme();
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  const mention = dismissed ? null : mentionAt(value, caret);
  const options = mention ? matchMembers(members, mention.query) : [];
  const to = useMemo(
    () => recipientLabel(recipientsFor(value, members).map((member) => member.name)),
    [value, members],
  );
  const canSend = !disabled && !busy && Boolean(value.trim());

  const pick = (member: ChannelMember) => {
    if (!mention) return;
    const next = insertMention(value, mention, member);
    setValue(next.value);
    setCaret(next.caret);
    setSelection({ start: next.caret, end: next.caret });
  };

  const send = async () => {
    const text = value.trim();
    if (!canSend) return;
    setBusy(true);
    setValue("");
    setCaret(0);
    const sent = await onSend(text);
    setBusy(false);
    // A refused post comes back to the box, unless something new was typed meanwhile.
    if (!sent) setValue((current) => current || text);
  };

  return (
    <View style={styles.wrap}>
      {options.length ? (
        <View
          accessibilityRole="menu"
          accessibilityLabel="Members"
          style={[styles.picker, { backgroundColor: c["bg-popover"], borderColor: c.border }]}
        >
          {options.map((member) => (
            <Pressable
              key={member.threadId}
              onPress={() => pick(member)}
              accessibilityRole="menuitem"
              accessibilityLabel={member.name}
              style={({ pressed }) => [
                styles.option,
                pressed && { backgroundColor: c["bg-active"] },
              ]}
            >
              <BotAvatar id={member.threadId} size={28} />
              <Txt style={styles.grow}>{member.name}</Txt>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View
        style={[
          styles.box,
          { backgroundColor: c["bg-raised"], borderColor: c.border, marginBottom: bottom },
        ]}
      >
        <TextInput
          value={value}
          onChangeText={(text) => {
            setValue(text);
            setDismissed(false);
            setSelection(undefined);
          }}
          onSelectionChange={(event) => {
            setCaret(event.nativeEvent.selection.end);
            setSelection(undefined);
          }}
          selection={selection}
          onBlur={() => setDismissed(true)}
          onFocus={() => setDismissed(false)}
          placeholder={`Message #${channelName}`}
          placeholderTextColor={c["text-dim"]}
          multiline
          maxLength={channelPostLimit}
          editable={!disabled}
          accessibilityLabel={`Message #${channelName}`}
          style={[styles.input, { color: c.text }]}
        />
        <View style={styles.controls}>
          <Txt v="meta" tone="muted" lines={1} style={styles.grow}>
            {to}
          </Txt>
          <Pressable
            onPress={() => void send()}
            disabled={!canSend}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={to ? `Send ${to.charAt(0).toLowerCase()}${to.slice(1)}` : "Send"}
            accessibilityState={{ disabled: !canSend }}
            style={[styles.send, { backgroundColor: c.primary, opacity: canSend ? 1 : 0.45 }]}
          >
            <Icon name="send" color={c["text-on-primary"]} size={18} stroke={2} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 12, gap: 8 },
  picker: { borderRadius: 18, borderWidth: 1, padding: 6 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: touch,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  box: {
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
  },
  input: {
    fontFamily: sans,
    fontSize: 15,
    lineHeight: 21,
    minHeight: 24,
    maxHeight: 140,
    paddingHorizontal: 4,
    paddingTop: 0,
    paddingBottom: 12,
  },
  controls: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 4 },
  grow: { flex: 1, minWidth: 0 },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
});
