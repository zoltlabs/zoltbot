import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { type AnswerDraft, approvalAnswer } from "../../data/interactions";
import { isStaffApproval } from "../../data/staff";
import { ago, type NeedsYouItem, needsYou, recentlyDone, workingNow } from "../../data/view";
import { answer, useAction } from "../../state/actions";
import { useClient, useSnapshot } from "../../state/link";
import { mono, useTheme } from "../../theme";
import { BotAvatar } from "../../ui/BotAvatar";
import { TabScreen } from "../../ui/chrome";
import { StaffCard } from "../../ui/interactions/StaffCard";
import { Button, Card, Chip, Group, styles as kitStyles, Row, Section, Txt } from "../../ui/kit";

function Approval({
  item,
  online,
}: {
  item: Extract<NeedsYouItem, { kind: "approval" }>;
  online: boolean;
}) {
  const { c } = useTheme();
  const { run, busy } = useAction();
  const [explaining, setExplaining] = useState(false);
  const [reason, setReason] = useState("");
  const allowOnce = item.choices.includes("allow_once") || item.choices.length === 0;
  // The answer carries a fresh timestamp, so a retry is keyed by the request and its version.
  const reply = (draft: AnswerDraft) =>
    run(
      "interaction.answer",
      {
        id: item.id,
        version: item.version,
        answer: answer(draft.action as "accept" | "decline", draft),
      },
      { key: `answer:${item.id}:${item.version}` },
    );
  const open = () => router.push(`/chat/${item.threadId}`);
  const disabled = !online || busy;
  return (
    <Card attention label={`Approval: ${item.title}`}>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityHint="Opens the chat with the full request"
        style={styles.cardHead}
      >
        <View style={styles.flex}>
          <Txt v="cardTitle">{item.title}</Txt>
          <Txt v="meta" tone="muted">
            {item.meta}
          </Txt>
        </View>
        <Chip label="Approval" tone="attention" />
      </Pressable>
      {item.why ? <Txt tone="secondary">{item.why}</Txt> : null}
      {item.command ? (
        <Txt v="code" style={[styles.code, { backgroundColor: c["bg-sunken"], fontFamily: mono }]}>
          {item.command}
        </Txt>
      ) : null}
      {item.diff.files ? (
        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`View changes: ${item.diff.files} files, ${item.diff.added} lines added, ${item.diff.removed} removed`}
          style={styles.diff}
        >
          <Txt v="meta" tone="secondary">
            {`${item.diff.files} ${item.diff.files === 1 ? "file" : "files"}`}
          </Txt>
          <Txt v="meta" style={{ fontFamily: mono, color: c.ok }}>{`+${item.diff.added}`}</Txt>
          <Txt v="meta" style={{ fontFamily: mono, color: c.danger }}>
            {`−${item.diff.removed}`}
          </Txt>
          <Txt v="meta" tone="accent" style={styles.flex}>
            View diff
          </Txt>
        </Pressable>
      ) : null}
      {explaining ? (
        <>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Tell the agent why"
            placeholderTextColor={c["text-dim"]}
            multiline
            autoFocus
            editable={!disabled}
            accessibilityLabel="Reason for denying"
            style={[
              styles.reason,
              { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-page"] },
            ]}
          />
          <View style={styles.pair}>
            <Button label="Back" disabled={busy} onPress={() => setExplaining(false)} />
            <Button
              label="Deny and send"
              kind="primary"
              disabled={disabled || !reason.trim()}
              onPress={() => void reply(approvalAnswer("deny", reason))}
              style={styles.flex}
            />
          </View>
        </>
      ) : (
        <>
          <View style={styles.pair}>
            {allowOnce ? (
              <Button
                label="Allow once"
                kind="primary"
                disabled={disabled}
                onPress={() => void reply(approvalAnswer("allow_once"))}
                style={styles.flex}
                a11y={`Allow once: ${item.command}`}
              />
            ) : null}
            <Button
              label="Deny"
              disabled={disabled}
              onPress={() => void reply(approvalAnswer("deny"))}
              style={styles.flex}
            />
          </View>
          <Button
            kind="plain"
            label="Deny with reason"
            disabled={disabled}
            onPress={() => setExplaining(true)}
          />
        </>
      )}
    </Card>
  );
}

/**
 * A request that needs the person: its title, then Zolt's reason for it when Zolt has triaged
 * it. The reason is the item's content, so it reads in full rather than as a muted caption.
 */
function NeedsYouRow({
  item,
  last,
}: {
  item: Exclude<NeedsYouItem, { kind: "approval" }>;
  last: boolean;
}) {
  const { c } = useTheme();
  const kind = item.kind === "review" ? "Needs review" : item.label;
  const when = item.kind === "review" ? "" : ago(item.createdAt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[`${kind}: ${item.title}`, item.why, when].filter(Boolean).join(", ")}
      onPress={() =>
        item.kind === "review" ? router.navigate("/tasks") : router.push(`/chat/${item.threadId}`)
      }
      style={({ pressed }) => [
        kitStyles.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
        pressed && { backgroundColor: c["bg-active"] },
      ]}
    >
      <View style={[kitStyles.rowText, styles.needsText]}>
        <Txt v="bodyMedium" lines={2}>
          {item.title}
        </Txt>
        {item.why ? <Txt tone="secondary">{item.why}</Txt> : null}
      </View>
      <View style={styles.needsSide}>
        <Chip label={kind} tone="attention" />
        {when ? (
          <Txt v="meta" tone="muted">
            {when}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function Overview() {
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const items = needsYou(snapshot);
  const approvals = items.filter((item) => item.kind === "approval");
  const rest = items.filter((item) => item.kind !== "approval");
  const working = workingNow(snapshot);
  const done = recentlyDone(snapshot);
  return (
    <TabScreen title="Activity">
      <Section
        title="Needs you"
        count={items.length}
        right={
          <Button
            kind="plain"
            label="See all"
            a11y="Open the Inbox"
            onPress={() => router.push("/inbox")}
            style={styles.link}
          />
        }
      />
      {items.length === 0 ? (
        <Txt tone="muted" style={styles.empty}>
          Nothing needs you right now.
        </Txt>
      ) : null}
      {approvals.map((item) => {
        const request = snapshot.entities.interaction?.find((row) => row.id === item.id);
        return isStaffApproval(request) && request ? (
          <StaffCard key={item.id} request={request} showChat />
        ) : (
          <Approval key={item.id} item={item} online={online} />
        );
      })}
      {rest.length ? (
        <Group>
          {rest.map((item, index) => (
            <NeedsYouRow key={item.id} item={item} last={index === rest.length - 1} />
          ))}
        </Group>
      ) : null}

      <Section title="Working now" count={working.length} />
      {working.length ? (
        <Group>
          {working.map((row, index) => (
            <Row
              key={row.threadId}
              title={row.title}
              detail={row.activity}
              mono={row.activity !== "Thinking" && row.activity !== "Writing"}
              left={<BotAvatar id={row.threadId} working />}
              right={<Chip label={row.isTask ? "Task" : "Chat"} tone="accent" dot />}
              last={index === working.length - 1}
              onPress={() => router.push(`/chat/${row.threadId}`)}
              label={`${row.title}, ${row.who}, ${row.activity}`}
            />
          ))}
        </Group>
      ) : (
        <Txt tone="muted" style={styles.empty}>
          No agent is working.
        </Txt>
      )}

      {done.length ? (
        <>
          <Section title="Recently done" />
          <Group>
            {done.map((row, index) => (
              <Row
                key={row.threadId}
                title={row.title}
                detail={ago(row.at)}
                left={<BotAvatar id={row.threadId} />}
                right={row.failed ? <Chip label="Failed" tone="danger" /> : undefined}
                last={index === done.length - 1}
                onPress={() => router.push(`/chat/${row.threadId}`)}
                label={`${row.title}, ${row.who}, ${row.failed ? "failed" : "done"}`}
              />
            ))}
          </Group>
        </>
      ) : null}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  needsText: { gap: 2 },
  needsSide: { alignItems: "flex-end", gap: 4 },
  flex: { flex: 1 },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  code: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, overflow: "hidden" },
  pair: { flexDirection: "row", gap: 8 },
  diff: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
  reason: {
    minHeight: 72,
    maxHeight: 140,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    textAlignVertical: "top",
  },
  empty: { marginHorizontal: 4 },
  link: { paddingHorizontal: 0 },
});
