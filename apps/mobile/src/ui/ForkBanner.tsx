import { body, text } from "@zoltbot/ui/chat/types";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { ForkInfo } from "../data/forks";
import type { Row } from "../data/transport";
import { useClient, useLink } from "../state/link";
import { useTheme } from "../theme";
import { Icon } from "./icons";
import { Button, Txt } from "./kit";

/**
 * The top of a forked chat: where it came from, which edit of the message this is (with the
 * others a tap away), and the history it inherited, loaded only when opened (thread.forkHistory).
 */
export function ForkBanner({ threadId, info }: { threadId: string; info: ForkInfo }) {
  const { c } = useTheme();
  const online = useClient((state) => state.status === "online");
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Row[] | "failed">();
  const versions = info.versions;
  const go = (id: string | undefined) => id && router.replace(`/chat/${id}`);
  const toggle = () => {
    setOpen(!open);
    if (open || history) return;
    void useLink
      .getState()
      .client?.getState()
      .call("thread.forkHistory", { id: threadId })
      .then((value) => setHistory(((value ?? {}) as { items?: Row[] }).items ?? []))
      .catch(() => setHistory("failed"));
  };
  return (
    <View style={[styles.banner, { borderColor: c.border, backgroundColor: c["bg-raised"] }]}>
      <View style={styles.row}>
        <Txt v="meta" tone="muted" style={styles.flex} lines={1}>
          {`${versions ? "Edited from" : "Forked from"} ${info.sourceTitle}`}
        </Txt>
        <Button
          kind="plain"
          label="Open"
          a11y={`Open ${info.sourceTitle}`}
          onPress={() => router.push(`/chat/${info.sourceThreadId}`)}
          style={styles.link}
        />
      </View>
      {versions ? (
        <View style={styles.row} accessibilityLabel="Versions of this message">
          <Pressable
            onPress={() => go(versions.ids[versions.index - 1])}
            disabled={versions.index <= 0}
            accessibilityRole="button"
            accessibilityLabel="Previous version"
            hitSlop={8}
            style={[styles.step, versions.index <= 0 && styles.off]}
          >
            <Icon name="back" size={16} color={c["accent-text"]} stroke={2} />
          </Pressable>
          <Txt v="meta" tone="secondary">
            {`Version ${versions.index + 1} of ${versions.ids.length}`}
          </Txt>
          <Pressable
            onPress={() => go(versions.ids[versions.index + 1])}
            disabled={versions.index >= versions.ids.length - 1}
            accessibilityRole="button"
            accessibilityLabel="Next version"
            hitSlop={8}
            style={[styles.step, versions.index >= versions.ids.length - 1 && styles.off]}
          >
            <Icon name="chevron" size={16} color={c["accent-text"]} stroke={2} />
          </Pressable>
        </View>
      ) : null}
      <Pressable
        onPress={toggle}
        disabled={!online && !history}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.row}
      >
        <Txt v="meta" tone="accent">
          {open ? "Hide earlier messages" : "Earlier messages"}
        </Txt>
        <Txt v="meta" tone="muted">
          {info.kind === "copied"
            ? `${info.copiedMessages ?? 0} copied${info.omittedMessages ? `, ${info.omittedMessages} left out` : ""}`
            : "Kept by the agent"}
        </Txt>
      </Pressable>
      {open ? (
        history === "failed" ? (
          <Txt v="meta" tone="danger">
            Earlier messages could not be loaded.
          </Txt>
        ) : history ? (
          history.length ? (
            history.map((item) => (
              <Txt
                key={`${text(item.threadId)}:${text(item.id)}`}
                v="meta"
                tone={item.kind === "user" ? "text" : "secondary"}
                lines={6}
              >
                {`${item.kind === "user" ? "You" : "Agent"}: ${text(body(item).text) || inputText(item)}`}
              </Txt>
            ))
          ) : (
            <Txt v="meta" tone="muted">
              No earlier messages.
            </Txt>
          )
        ) : (
          <Txt v="meta" tone="muted">
            Loading…
          </Txt>
        )
      ) : null}
    </View>
  );
}

function inputText(item: Row) {
  const input = body(item).input;
  return Array.isArray(input)
    ? (input as Row[])
        .filter((part) => part.type === "text")
        .map((part) => text(part.text))
        .join("\n")
    : "";
}

const styles = StyleSheet.create({
  banner: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
  flex: { flex: 1 },
  link: { minHeight: 32, paddingHorizontal: 0 },
  step: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.35 },
});
