import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import {
  ACTIVE,
  type DelegationRow,
  delegationSpend,
  delegationTitle,
  type ManagerCard,
  type NoticeLine,
  noticeText,
  resultTitle,
  rowMeta,
  STATUS_LABELS,
  testsText,
} from "../data/manager";
import { useAction } from "../state/actions";
import { useClient } from "../state/link";
import { mono, touch, useTheme } from "../theme";
import { Icon } from "./icons";
import { Avatar, Button, Card, Chip, Txt } from "./kit";

type ResultCardData = Extract<ManagerCard, { kind: "result" }>;

/** The current time, refreshed every 30 seconds for "Running · 4 min". */
function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
const openChat = (threadId: string | null) => threadId && router.push(`/chat/${threadId}`);

/** A manager's card in its chat: the tasks it assigned in one turn, or a result to review. */
export function ManagerCardView({ card }: { card: ManagerCard }) {
  return card.kind === "delegation" ? (
    <DelegationCard rows={card.rows} />
  ) : (
    <ResultCard card={card} />
  );
}

function DelegationCard({ rows }: { rows: DelegationRow[] }) {
  const { c } = useTheme();
  const now = useNow();
  const title = delegationTitle(rows);
  const total = delegationSpend(rows);
  return (
    <Card style={styles.flush} label={title}>
      <View style={styles.cardHead}>
        <Txt v="section" accessibilityRole="header" style={styles.flex}>
          {title}
        </Txt>
        {total ? (
          <Txt v="meta" tone="muted">
            {total}
          </Txt>
        ) : null}
      </View>
      {rows.map((row) => (
        <View key={row.taskId} style={[styles.taskRow, { borderTopColor: c.border }]}>
          <TaskLine row={row} now={now} />
        </View>
      ))}
    </Card>
  );
}

function TaskLine({ row, now }: { row: DelegationRow; now: number }) {
  const { run, busy } = useAction();
  const online = useClient((state) => state.status === "online");
  const [stopped, setStopped] = useState(false);
  const status = stopped ? "cancelled" : row.status;
  const shown = { ...row, status };
  const active = ACTIVE.includes(status);
  const meta = rowMeta(shown, now);
  const stop = () =>
    Alert.alert("Stop this task?", `${row.owner.name} stops now. You can retry it later.`, [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: () =>
          void run("task.cancel", { id: row.taskId, confirmed: true }).then((result) => {
            if (result) setStopped(true);
          }),
      },
    ]);
  return (
    <>
      <Pressable
        onPress={() => openChat(row.owner.threadId)}
        disabled={!row.owner.threadId}
        accessibilityRole="button"
        accessibilityLabel={`${row.title}, ${row.owner.name}, ${meta}`}
        accessibilityHint={row.owner.threadId ? `Opens ${row.owner.name}’s chat` : undefined}
        style={styles.taskText}
      >
        <Avatar id={row.owner.agentId || row.owner.name} size={24} />
        <View style={styles.flex}>
          <Txt v="bodyMedium">{row.title}</Txt>
          <Txt v="meta" tone="muted">
            {meta}
          </Txt>
        </View>
      </Pressable>
      {active ? (
        <Button
          label="Stop"
          a11y={`Stop ${row.title}`}
          disabled={!online || busy}
          onPress={stop}
          style={styles.small}
        />
      ) : row.owner.threadId ? (
        <Button
          label="Open"
          a11y={`Open ${row.title}`}
          onPress={() => openChat(row.owner.threadId)}
          style={styles.small}
        />
      ) : null}
    </>
  );
}

function fileLine(files: string[]) {
  if (files.length <= 3) return files.join(" · ");
  return `${files.slice(0, 2).join(" · ")} and ${files.length - 2} more`;
}

function ResultCard({ card }: { card: ResultCardData }) {
  const { run, busy } = useAction();
  const online = useClient((state) => state.status === "online");
  const [decided, setDecided] = useState<"accepted" | "sent_back">();
  const review = (decision: "accept" | "changes", feedback?: string) =>
    run("task.review", {
      id: card.taskId,
      revision: card.revision,
      decision,
      ...(feedback ? { feedback } : {}),
      confirmed: true,
    }).then((result) => {
      if (result) setDecided(decision === "accept" ? "accepted" : "sent_back");
    });
  const sendBack = () =>
    Alert.prompt("Send back", "What should change?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Send back",
        onPress: (value?: string) => {
          if (value?.trim()) void review("changes", value.trim());
        },
      },
    ]);
  const open = card.status === "review" && !decided;
  const status = decided === "accepted" ? "Accepted" : decided === "sent_back" ? "Sent back" : "";
  const title = resultTitle(card);
  const tests = testsText(card.tests);
  const disabled = !online || busy;
  return (
    <Card attention={open} label={title}>
      <View style={styles.resultHead}>
        <Avatar id={card.owner.agentId || card.owner.name} size={24} />
        <Txt v="section" accessibilityRole="header" style={styles.flex}>
          {title}
        </Txt>
        {!open ? (
          <Chip
            label={status || STATUS_LABELS[card.status]}
            tone={card.status === "failed" && !decided ? "danger" : "neutral"}
          />
        ) : null}
      </View>
      <View style={styles.resultBody}>
        {card.files.length ? (
          <Txt v="meta" tone="secondary" style={{ fontFamily: mono }}>
            {fileLine(card.files)}
          </Txt>
        ) : null}
        {tests ? (
          <Txt v="meta" tone={card.tests === "passed" ? "muted" : "danger"}>
            {tests}
          </Txt>
        ) : null}
        {card.note ? (
          <Txt tone="secondary" style={styles.note}>
            {`${card.manager}: ${card.note}`}
          </Txt>
        ) : null}
      </View>
      <View style={styles.actions}>
        {open ? (
          <>
            <Button
              label="Accept"
              kind="primary"
              a11y={`Accept ${card.title}`}
              disabled={disabled}
              onPress={() => void review("accept")}
            />
            <Button
              label="Send back"
              a11y={`Send back ${card.title}`}
              disabled={disabled}
              onPress={sendBack}
            />
          </>
        ) : null}
        {card.owner.threadId ? (
          <Button
            label="Open chat"
            a11y={`Open ${card.owner.name}’s chat`}
            onPress={() => openChat(card.owner.threadId)}
          />
        ) : null}
      </View>
    </Card>
  );
}

/** One centered line between agents or about a task; tap to read the whole message. */
export function NoticeRow({ notice }: { notice: NoticeLine }) {
  const [open, setOpen] = useState(false);
  if (notice.kind === "waiting") return <WaitingRow notice={notice} />;
  const line = noticeText(notice);
  const more = !!notice.detail && notice.detail !== notice.text;
  return (
    <Pressable
      onPress={() => setOpen(!open)}
      disabled={!more}
      accessibilityRole={more ? "button" : "text"}
      accessibilityState={more ? { expanded: open } : undefined}
      accessibilityLabel={line.replace(" → ", " to ")}
      style={styles.notice}
    >
      <Txt v="meta" tone="muted" style={styles.center} lines={open ? undefined : 2}>
        {line}
      </Txt>
      {open && more ? (
        <Txt v="meta" tone="secondary" style={styles.center} selectable>
          {notice.detail}
        </Txt>
      ) : null}
    </Pressable>
  );
}

/** "Waiting on Fix checkout tax rounding" with Wake now, while a manager waits on its work. */
function WaitingRow({ notice }: { notice: NoticeLine }) {
  const { c } = useTheme();
  const { run, busy } = useAction();
  const online = useClient((state) => state.status === "online");
  const [woken, setWoken] = useState(false);
  const wake = () =>
    notice.threadId &&
    notice.waitId &&
    void run(
      "company.wakeNow",
      { threadId: notice.threadId, waitId: notice.waitId },
      { key: `wake:${notice.waitId}` },
    ).then((result) => {
      if (result) setWoken(true);
    });
  const line = noticeText(notice);
  return (
    <View style={[styles.waiting, { backgroundColor: c["bg-sunken"] }]}>
      <View style={[styles.dot, { backgroundColor: c["text-muted"] }]} />
      <Txt tone="secondary" style={styles.flex}>
        {woken ? "Waking up…" : line}
      </Txt>
      {woken ? null : (
        <Button
          label="Wake now"
          a11y={`Wake now: ${line}`}
          disabled={!online || busy}
          onPress={wake}
          style={styles.small}
        />
      )}
    </View>
  );
}

/** "Switched to Work. Back to Personal at 3:00 PM." */
export function SwitchNotice({ text }: { text: string }) {
  const { c } = useTheme();
  return (
    <View style={styles.switch} accessible accessibilityLabel={text}>
      <Icon name="swap" size={14} stroke={2} color={c["text-muted"]} />
      <Txt v="meta" tone="muted" style={styles.flexShrink}>
        {text}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1, textAlign: "center" },
  flush: { padding: 0, gap: 0, overflow: "hidden" },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  taskText: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minHeight: touch },
  small: { paddingHorizontal: 12, borderRadius: touch / 2 },
  resultHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  resultBody: { gap: 4, paddingLeft: 34 },
  note: { marginTop: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 34 },
  notice: { paddingHorizontal: 20, gap: 4, minHeight: 24, justifyContent: "center" },
  center: { textAlign: "center" },
  waiting: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 4,
    paddingLeft: 14,
    paddingRight: 4,
    borderRadius: 26,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  switch: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
});
