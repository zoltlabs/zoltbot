import { router } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, Share, StyleSheet, View } from "react-native";
import { childSummary, type TranscriptRow } from "../data/view";
import { mono, useTheme } from "../theme";
import { Icon } from "./icons";
import { Button, Txt } from "./kit";
import { Markdown } from "./Markdown";
import { pick } from "./SessionControls";

function MessageActions({
  row,
  edit,
  forward,
}: {
  row: TranscriptRow;
  edit?: () => void;
  forward?: () => void;
}) {
  const [error, setError] = useState("");
  const options = [
    ...(edit
      ? [{ label: row.queued ? "Edit queued message" : "Edit and send again", run: edit }]
      : []),
    ...(forward ? [{ label: "Send to another chat", run: forward }] : []),
    {
      label: "Share message",
      run: () => {
        void Share.share({ message: row.text }).catch(() =>
          setError("Could not open sharing. Try again."),
        );
      },
    },
  ];
  return (
    <View style={{ alignSelf: "flex-start" }}>
      <Button
        kind="plain"
        label="Message actions"
        onPress={() =>
          pick(
            "Message actions",
            undefined,
            options.map((option) => option.label),
            (index) => options[index]?.run(),
          )
        }
      />
      {error ? (
        <Txt v="meta" tone="danger">
          {error}
        </Txt>
      ) : null}
    </View>
  );
}

function ToolRow({ row, threadId }: { row: TranscriptRow; threadId?: string }) {
  const { c } = useTheme();
  const recovered =
    row.activityItem && (row.activityItem.body as Record<string, unknown>)?.recovered === true;
  const status = recovered ? "ok" : row.status;
  const label = recovered
    ? "fixed on retry"
    : status === "running"
      ? "running"
      : status === "ok"
        ? "done"
        : "failed";
  return (
    <Pressable
      onPress={
        threadId
          ? () =>
              router.push(
                `/chat/tool?id=${encodeURIComponent(threadId)}&item=${encodeURIComponent(row.id)}`,
              )
          : undefined
      }
      disabled={!threadId}
      accessibilityRole={threadId ? "button" : "text"}
      accessibilityHint={threadId ? "Opens the full tool result" : undefined}
      accessibilityLabel={`${row.text}, ${label}${row.added ? `, ${row.added} lines added, ${row.removed} removed` : ""}`}
      style={[styles.tool, { backgroundColor: c["bg-sunken"], borderColor: c.border }]}
    >
      <Icon
        name={status === "running" ? "spinner" : status === "ok" ? "check" : "warning"}
        size={14}
        stroke={2.4}
        color={status === "running" ? c["accent-text"] : status === "ok" ? c.ok : c.danger}
      />
      <Txt v="meta" tone="secondary" style={[styles.toolText, { fontFamily: mono }]}>
        {row.text}
      </Txt>
      {recovered || status === "failed" ? (
        <Txt v="meta" tone={recovered ? "secondary" : "danger"}>
          {recovered ? "Fixed on retry" : "Failed"}
        </Txt>
      ) : null}
      {row.added !== undefined ? (
        <Txt v="meta" style={{ fontFamily: mono, color: c.ok }}>{`+${row.added}`}</Txt>
      ) : null}
      {row.removed !== undefined ? (
        <Txt v="meta" style={{ fontFamily: mono, color: c.danger }}>{`−${row.removed}`}</Txt>
      ) : null}
    </Pressable>
  );
}

/** A tool that started a subagent, with the subagent's steps folded underneath. */
function ToolGroup({ row, threadId }: { row: TranscriptRow; threadId?: string }) {
  const { c } = useTheme();
  const children = row.children ?? [];
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.group}>
      <ToolRow row={row} threadId={threadId} />
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Subagent steps, ${childSummary(children)}`}
        style={styles.groupToggle}
      >
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevron" size={12} color={c["text-muted"]} stroke={2} />
        </View>
        <Txt v="meta" tone="muted">
          {childSummary(children)}
        </Txt>
      </Pressable>
      {open ? (
        <View style={[styles.children, { borderLeftColor: c.border }]}>
          {children.map((child) => (
            <Message key={child.id} row={child} threadId={threadId} compact />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Zoltbot's own notice to the agent: a wake-up or the brief, folded to one line. */
function EventRow({ row }: { row: TranscriptRow }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const title =
    row.event === "brief" ? "Morning brief" : row.event === "wake" ? "Woke up on its own" : "";
  if (!title)
    return (
      <View style={styles.asked} accessible accessibilityLabel={row.text}>
        <Icon name="spark" size={14} color={c["text-muted"]} stroke={2} />
        <Txt v="meta" tone="muted" style={styles.flex}>
          {row.text}
        </Txt>
      </View>
    );
  return (
    <Pressable
      onPress={() => setOpen(!open)}
      disabled={!row.text}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={title}
      style={styles.event}
    >
      <View style={styles.asked}>
        <Icon name="spark" size={14} color={c["accent-text"]} stroke={2} />
        <Txt v="meta" tone="muted">
          {title}
        </Txt>
      </View>
      {open ? (
        <Txt v="meta" tone="muted" style={styles.eventText}>
          {row.text}
        </Txt>
      ) : null}
    </Pressable>
  );
}

export function Message({
  row,
  compact,
  onEdit,
  onEditSent,
  onForward,
  threadId,
  edits,
}: {
  row: TranscriptRow;
  compact?: boolean;
  threadId?: string;
  /** Takes a queued message back so it can be edited. */
  onEdit?: (row: TranscriptRow) => void;
  /** Starts a new chat from before a sent message, with an edited copy of it. */
  onEditSent?: (row: TranscriptRow) => void;
  /** How many edited copies of this message exist, and how to open the newest. */
  edits?: { count: number; open: () => void };
  /** Sends a copy of an agent's message to another chat. */
  onForward?: (row: TranscriptRow) => void;
}) {
  const { c } = useTheme();
  if (row.wake)
    return (
      <View style={{ gap: 8 }} accessibilityLabel="Chat woke up">
        <Txt v="bodyMedium">Chat woke up</Txt>
        <Txt>{row.text}</Txt>
        {row.wakeEvidence ? (
          <Button
            label="View wake evidence"
            onPress={() => {
              const url = row.wakeEvidence ?? "";
              if (url.startsWith("#chat/"))
                router.push(`/chat/${decodeURIComponent(url.slice(6))}`);
              else if (url.startsWith("https://github.com/")) void Linking.openURL(url);
            }}
          />
        ) : null}
      </View>
    );
  if (row.event) return <EventRow row={row} />;
  if (row.brief && row.kind === "message")
    return (
      <View
        style={[styles.artifact, { borderColor: c.border, backgroundColor: c["bg-raised"] }]}
        accessibilityLabel={`Morning brief: ${row.text}`}
      >
        <View style={styles.asked}>
          <Icon name="spark" size={14} color={c["accent-text"]} stroke={2} />
          <Txt v="meta" tone="accent">
            Morning brief
          </Txt>
        </View>
        <Txt style={styles.prose}>{row.text}</Txt>
        <Button kind="plain" label="Open Needs you" onPress={() => router.navigate("/")} />
      </View>
    );
  if (row.compareId)
    return (
      <View accessibilityLabel="Compare result">
        <Txt>{row.text}</Txt>
        <Button
          label="View side by side"
          onPress={() => router.push(`/chat/compare/${row.compareId}`)}
        />
      </View>
    );
  if (row.kind === "artifact" && row.artifact) {
    const artifact = row.artifact;
    const version = artifact.number ? `v${artifact.number}` : "Version unavailable";
    const fallback =
      artifact.availability === "held"
        ? "This version is held for review on Mac."
        : artifact.availability === "unavailable"
          ? "Files unavailable. Open on the producing Mac."
          : "Saved version available. Open versions to preview or compare.";
    return (
      <View
        style={[styles.artifact, { borderColor: c.border, backgroundColor: c["bg-raised"] }]}
        accessible
        accessibilityLabel={`${row.unanchored ? "From an earlier or unloaded turn. " : ""}${artifact.title}, ${artifact.kind}, ${version}. ${artifact.newer ? "Newer version available on Mac. " : ""}${fallback}`}
      >
        {row.unanchored ? (
          <Txt v="meta" tone="muted">
            From an earlier or unloaded turn
          </Txt>
        ) : null}
        <Txt v="cardTitle">{artifact.title}</Txt>
        <Txt v="meta" tone="secondary">
          {artifact.kind} · {version}
        </Txt>
        {artifact.newer ? (
          <Txt v="meta" tone="muted">
            Newer version available on Mac
          </Txt>
        ) : null}
        <Txt v="meta" tone="muted">
          {fallback}
        </Txt>
        {threadId ? (
          <Button
            label="View and compare versions"
            onPress={() =>
              router.push(
                `/chat/artifacts?id=${encodeURIComponent(threadId ?? "")}&versionId=${encodeURIComponent(artifact.versionId)}`,
              )
            }
          />
        ) : null}
      </View>
    );
  }
  if (row.kind === "tool")
    return row.children?.length ? (
      <ToolGroup row={row} threadId={threadId} />
    ) : (
      <ToolRow row={row} threadId={threadId} />
    );
  if (row.kind === "interaction")
    return (
      <View style={styles.asked} accessible accessibilityLabel={row.text}>
        <View
          style={[styles.askedDot, { backgroundColor: row.pending ? c.attention : c["text-dim"] }]}
        />
        <Txt v="meta" tone={row.pending ? "attention" : "muted"}>
          {row.text}
        </Txt>
      </View>
    );
  if (row.kind === "user")
    return (
      <View style={styles.mine}>
        <Pressable
          disabled={!(row.turnId && onEditSent)}
          onLongPress={() => onEditSent?.(row)}
          accessibilityLabel={`You: ${row.text}${row.artifactReference ? `. Artifact reference: ${row.artifactReference}` : ""}${row.delivery ? `. ${row.delivery}` : ""}`}
          {...(row.turnId && onEditSent
            ? {
                accessibilityHint: "Touch and hold to edit and send again",
                accessibilityActions: [{ name: "edit", label: "Edit and send again" }],
                onAccessibilityAction: () => onEditSent(row),
              }
            : {})}
          style={[styles.bubble, { backgroundColor: c["bg-popover"] }]}
        >
          {row.artifactReference ? (
            <Txt v="meta" tone="secondary">
              Artifact reference: {row.artifactReference}
            </Txt>
          ) : null}
          <Txt selectable>{row.text}</Txt>
        </Pressable>
        {edits?.count ? (
          <Button
            kind="plain"
            label={`${edits.count} ${edits.count === 1 ? "edit" : "edits"}`}
            a11y={`Open the newest of ${edits.count} edited copies`}
            onPress={edits.open}
            style={styles.edit}
          />
        ) : null}
        <MessageActions
          row={row}
          {...(row.queued && onEdit
            ? { edit: () => onEdit(row) }
            : row.turnId && onEditSent
              ? { edit: () => onEditSent(row) }
              : {})}
        />
        {row.delivery ? (
          <View style={styles.delivery}>
            <Txt v="meta" tone="muted">
              {row.delivery}
            </Txt>
          </View>
        ) : null}
      </View>
    );
  const prose =
    row.kind === "message" && !compact ? (
      <View style={{ gap: 4 }}>
        <Markdown value={row.text} />
        {row.streaming ? <Txt tone="secondary">▍</Txt> : null}
      </View>
    ) : (
      <Txt
        v={compact ? "meta" : "body"}
        tone={row.kind === "thought" || compact ? "muted" : "text"}
        style={compact ? undefined : styles.prose}
      >
        {row.kind === "thought" ? `Thinking: ${row.text}` : row.text}
        {row.streaming ? <Txt style={{ color: c.accent }}>{" ▍"}</Txt> : null}
      </Txt>
    );
  if (row.kind !== "message" || row.streaming || compact) return prose;
  return (
    <View style={{ gap: 4 }}>
      <Pressable
        onLongPress={() => onForward?.(row)}
        accessibilityHint={onForward ? "Touch and hold to send to another chat" : undefined}
        accessibilityActions={
          onForward ? [{ name: "forward", label: "Send to another chat" }] : undefined
        }
        onAccessibilityAction={() => onForward?.(row)}
      >
        {prose}
      </Pressable>
      <MessageActions row={row} {...(onForward ? { forward: () => onForward(row) } : {})} />
    </View>
  );
}

const styles = StyleSheet.create({
  artifact: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 6 },
  flex: { flex: 1 },
  mine: { alignItems: "flex-end", gap: 2 },
  delivery: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4 },
  edit: { minHeight: 32, paddingHorizontal: 0 },
  event: { gap: 4, minHeight: 32, justifyContent: "center" },
  eventText: { paddingLeft: 26 },
  bubble: {
    alignSelf: "flex-end",
    marginLeft: 56,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    borderBottomRightRadius: 6,
  },
  prose: { lineHeight: 22 },
  tool: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolText: { flex: 1, fontSize: 12 },
  group: { gap: 4 },
  groupToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  children: { marginLeft: 14, paddingLeft: 10, borderLeftWidth: 2, gap: 8 },
  asked: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  askedDot: { width: 6, height: 6, borderRadius: 3 },
});
