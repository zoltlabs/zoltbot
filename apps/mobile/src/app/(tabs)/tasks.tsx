import { router } from "expo-router";
import { Alert, StyleSheet, View } from "react-native";
import type { Row as Entity } from "../../data/transport";
import {
  activity,
  ago,
  currentResult,
  groupTitles,
  holdText,
  place,
  profileName,
  taskGroups,
  taskStateLabel,
  text,
} from "../../data/view";
import { useAction } from "../../state/actions";
import { useClient, useSnapshot } from "../../state/link";
import { mono, useTheme } from "../../theme";
import { BrowserContext } from "../../ui/BrowserContext";
import { ConnectionsContext } from "../../ui/ConnectionsContext";
import { RoundButton, TabScreen } from "../../ui/chrome";
import { KnowledgeContext } from "../../ui/KnowledgeContext";
import { Button, Card, Chip, type ChipTone, Group, Row, Section, Txt } from "../../ui/kit";
import { ShippingContext } from "../../ui/ShippingContext";
import { SkillsContext } from "../../ui/SkillsContext";
import { WorktreeChanges } from "../../ui/WorktreeChanges";

const tones: Record<string, ChipTone> = {
  review: "attention",
  failed: "danger",
  running: "accent",
  blocked: "neutral",
  queued: "neutral",
  completed: "ok",
  cancelled: "neutral",
};

function TaskCard({ task, online }: { task: Entity; online: boolean }) {
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const { run, busy } = useAction();
  const id = text(task.id);
  const state = text(task.state);
  const threadId = text(task.threadId);
  const meta = [place(snapshot, task), profileName(snapshot, task.ownerAgentId)];
  if (state === "review") meta.push(`Revision ${task.revision}`);
  else meta.push(ago(task.updatedAt));
  const result = currentResult(task, snapshot.entities.taskResult ?? []);
  const review = (decision: "accept" | "changes", feedback?: string) =>
    run("task.review", {
      id,
      revision: Number(task.revision),
      decision,
      ...(feedback ? { feedback } : {}),
      confirmed: true,
    });
  const requestChanges = () =>
    Alert.prompt("Request changes", "Tell the agent what to change.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Send",
        onPress: (value?: string) => void review("changes", value?.trim() || undefined),
      },
    ]);
  const stop = () =>
    Alert.alert("Stop this task?", "The agent stops now. You can retry it later.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: () => void run("task.cancel", { id, confirmed: true }),
      },
    ]);
  return (
    <Card attention={state === "review" || state === "failed"} label={text(task.title)}>
      <View style={styles.head}>
        <View style={styles.flex}>
          <Txt v="cardTitle">{text(task.title)}</Txt>
          <Txt v="meta" tone="muted">
            {meta.filter(Boolean).join(" · ")}
          </Txt>
        </View>
        <Chip
          label={taskStateLabel(task)}
          tone={tones[state] ?? "neutral"}
          dot={state === "running"}
        />
      </View>
      {state === "running" ? (
        <Txt
          v="meta"
          tone="secondary"
          lines={1}
          style={[styles.activity, { backgroundColor: c["bg-sunken"], fontFamily: mono }]}
        >
          {activity(snapshot, threadId)}
        </Txt>
      ) : null}
      {state === "review" && result ? <Txt tone="secondary">{text(result.summary)}</Txt> : null}
      {(state === "queued" || state === "blocked") && holdText(task) ? (
        <Txt v="meta" tone="muted">
          {holdText(task)}
        </Txt>
      ) : null}
      <ShippingContext task={task} />
      <KnowledgeContext task={task} />
      <SkillsContext task={task} online={online} />
      <ConnectionsContext task={task} online={online} />
      <BrowserContext task={task} online={online} />
      <WorktreeChanges task={task} online={online} />
      {state === "review" ? (
        <View style={styles.pair}>
          <Button
            label="Accept"
            kind="primary"
            disabled={!online || busy}
            onPress={() => void review("accept")}
            style={styles.flex}
          />
          <Button
            label="Request changes"
            disabled={!online || busy}
            onPress={requestChanges}
            style={styles.flex}
          />
        </View>
      ) : null}
      {state === "running" ? (
        <View style={styles.pair}>
          <Button
            label="Open conversation"
            onPress={() => router.push(`/chat/${threadId}`)}
            style={styles.flex}
          />
          <Button
            label="Stop"
            disabled={!online || busy}
            onPress={stop}
            a11y={`Stop ${text(task.title)}`}
          />
        </View>
      ) : null}
      {state === "failed" ? (
        <Button
          label="Retry"
          kind="primary"
          disabled={!online || busy}
          onPress={() => void run("task.retry", { id })}
        />
      ) : null}
    </Card>
  );
}

export default function Tasks() {
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const groups = taskGroups(snapshot);
  const empty = Object.values(groups).every((list) => list.length === 0);
  return (
    <TabScreen
      title="Tasks"
      right={<RoundButton label="New task" onPress={() => router.push("/new?mode=task")} />}
    >
      <Button label="Routines" onPress={() => router.push("/routines")} />
      {empty ? (
        <Txt tone="muted" style={styles.empty}>
          No tasks yet. A task runs on its own and comes back for your review.
        </Txt>
      ) : null}
      {(["needs_you", "running", "queued"] as const).map((key) =>
        groups[key].length ? (
          <View key={key} style={styles.group}>
            <Section title={groupTitles[key]} count={groups[key].length} />
            {groups[key].map((task) => (
              <TaskCard key={text(task.id)} task={task} online={online} />
            ))}
          </View>
        ) : null,
      )}
      {groups.done.length ? (
        <>
          <Section title={groupTitles.done} count={groups.done.length} />
          <Group>
            {groups.done.map((task, index) => (
              <Row
                key={text(task.id)}
                title={text(task.title)}
                meta={`${snapshot.entities.shipping?.some((r) => r.taskId === task.id) ? "PR linked · Inspect on Mac · " : ""}${place(snapshot, task)} · ${ago(task.updatedAt)}${task.workspaceMode === "worktree" ? " · Worktree: Git actions on your Mac" : ""}`}
                right={
                  <Chip label={taskStateLabel(task)} tone={tones[text(task.state)] ?? "neutral"} />
                }
                last={index === groups.done.length - 1}
                {...(task.threadId
                  ? { onPress: () => router.push(`/chat/${text(task.threadId)}`) }
                  : {})}
              />
            ))}
          </Group>
        </>
      ) : null}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  activity: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, overflow: "hidden" },
  pair: { flexDirection: "row", gap: 8 },
  group: { gap: 10 },
  empty: { marginHorizontal: 4 },
});
