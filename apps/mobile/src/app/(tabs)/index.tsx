import { terms } from "@zoltbot/protocol";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { type AnswerDraft, approvalAnswer } from "../../data/interactions";
import {
  ago,
  countsText,
  type NeedsYouItem,
  needsYou,
  projectSummaries,
  recentlyDone,
  workingNow,
  zolt,
} from "../../data/view";
import { answer, useAction } from "../../state/actions";
import { useClient, useSnapshot } from "../../state/link";
import { mono, sans, touch, useTheme } from "../../theme";
import { TabScreen } from "../../ui/chrome";
import { Icon } from "../../ui/icons";
import { Avatar, Button, Card, Chip, Group, Row, Section, Txt } from "../../ui/kit";

/** Zolt on top of Home: the newest thing it said, and a line to ask it something. */
function ZoltCard({ online }: { online: boolean }) {
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const { run, busy } = useAction();
  const [draft, setDraft] = useState("");
  const summary = zolt(snapshot);
  const { threadId, latest } = summary;
  const ask = async () => {
    const message = draft.trim();
    if (!message || !threadId) return;
    const result = await run("turn.send", {
      threadId,
      input: [{ type: "text", text: message }],
      mode: "queue",
    });
    if (result) setDraft("");
  };
  return (
    <Card label={summary.name}>
      <Pressable
        onPress={() => threadId && router.push(`/chat/${threadId}`)}
        disabled={!threadId}
        accessibilityRole="button"
        accessibilityHint={`Opens your chat with ${summary.name}`}
        style={styles.zoltHead}
      >
        <View style={[styles.zoltMark, { backgroundColor: c["accent-soft"] }]}>
          <Icon name="spark" size={16} color={c["accent-text"]} stroke={2} />
        </View>
        <View style={styles.flex}>
          <Txt v="cardTitle">{summary.name}</Txt>
          {latest ? (
            <Txt v="meta" tone="muted">
              {[latest.brief ? "Morning brief" : "", ago(latest.at)].filter(Boolean).join(" · ")}
            </Txt>
          ) : null}
        </View>
        {summary.working ? <Chip label="Working" tone="accent" dot /> : null}
      </Pressable>
      {latest ? (
        <Txt tone="secondary" lines={4}>
          {latest.text}
        </Txt>
      ) : (
        <Txt tone="muted">
          {threadId ? "Nothing yet today." : `Start ${summary.name} on your Mac to ask it here.`}
        </Txt>
      )}
      {threadId ? (
        <View style={styles.ask}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Ask ${summary.name}`}
            placeholderTextColor={c["text-dim"]}
            editable={online}
            returnKeyType="send"
            onSubmitEditing={() => void ask()}
            accessibilityLabel={`Ask ${summary.name}`}
            style={[
              styles.askInput,
              { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-page"] },
            ]}
          />
          <Pressable
            onPress={() => void ask()}
            disabled={!online || busy || !draft.trim()}
            accessibilityRole="button"
            accessibilityLabel={`Send to ${summary.name}`}
            style={[
              styles.askSend,
              { backgroundColor: c.primary, opacity: online && draft.trim() ? 1 : 0.45 },
            ]}
          >
            <Icon name="send" color={c["text-on-primary"]} size={18} stroke={2} />
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

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

export default function Overview() {
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const items = needsYou(snapshot);
  const approvals = items.filter((item) => item.kind === "approval");
  const rest = items.filter((item) => item.kind !== "approval");
  const working = workingNow(snapshot);
  const done = recentlyDone(snapshot);
  const projects = projectSummaries(snapshot);
  return (
    <TabScreen title="Overview">
      <ZoltCard online={online} />
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
      {approvals.map((item) => (
        <Approval key={item.id} item={item} online={online} />
      ))}
      {rest.length ? (
        <Group>
          {rest.map((item, index) => (
            <Row
              key={item.id}
              title={item.title}
              meta={item.why ?? item.meta}
              last={index === rest.length - 1}
              label={`${item.kind === "review" ? "Needs review" : item.label}: ${item.title}`}
              onPress={() =>
                item.kind === "review"
                  ? router.navigate("/tasks")
                  : router.push(`/chat/${item.threadId}`)
              }
              right={
                <Chip
                  label={item.kind === "review" ? "Needs review" : item.label}
                  tone="attention"
                />
              }
            />
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
              meta={`${row.who} · ${row.activity}`}
              mono={row.activity !== "Thinking" && row.activity !== "Writing"}
              left={<Avatar id={row.agentId} />}
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
                meta={`${row.who} · ${ago(row.at)}`}
                left={<Avatar id={row.agentId} />}
                right={row.failed ? <Chip label="Failed" tone="danger" /> : undefined}
                last={index === done.length - 1}
                onPress={() => router.push(`/chat/${row.threadId}`)}
                label={`${row.title}, ${row.who}, ${row.failed ? "failed" : "done"}`}
              />
            ))}
          </Group>
        </>
      ) : null}

      <Section
        title={terms.workspace.Many}
        right={
          <Button
            kind="plain"
            label={`All ${terms.workspace.many}`}
            onPress={() => router.push("/projects")}
            style={styles.link}
          />
        }
      />
      <Group>
        {projects.map((project, index) => (
          <Row
            key={project.id}
            title={project.name}
            meta={countsText(project.counts)}
            last={index === projects.length - 1}
            onPress={() => router.push(`/projects/${project.id}`)}
          />
        ))}
      </Group>
    </TabScreen>
  );
}

const styles = StyleSheet.create({
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
  zoltHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  zoltMark: {
    width: 32,
    height: 32,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  ask: { flexDirection: "row", alignItems: "center", gap: 8 },
  askInput: {
    fontFamily: sans,
    flex: 1,
    minHeight: touch,
    borderRadius: 22,
    borderWidth: 1,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  askSend: {
    width: touch,
    height: touch,
    borderRadius: touch / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  link: { paddingHorizontal: 0 },
});
