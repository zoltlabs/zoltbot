import { Alert, StyleSheet, View } from "react-native";
import type { Row } from "../data/transport";
import { holdText, text } from "../data/view";
import { useAction } from "../state/actions";
import { BrowserContext } from "./BrowserContext";
import { ConnectionsContext } from "./ConnectionsContext";
import { KnowledgeContext } from "./KnowledgeContext";
import { Button, Txt } from "./kit";
import { ShippingContext } from "./ShippingContext";
import { SkillsContext } from "./SkillsContext";
import { WorktreeChanges } from "./WorktreeChanges";

/**
 * A task's context at the top of its chat: why it waits, what it ships, the knowledge, skills,
 * connections, browser and worktree it runs with, and Stop or Retry. The Tasks tab lists tasks
 * as rows and opens this chat for the rest.
 */
export function TaskContext({ task, online }: { task: Row; online: boolean }) {
  const { run, busy } = useAction();
  const id = text(task.id);
  const state = text(task.state);
  const stop = () =>
    Alert.alert("Stop this task?", "The agent stops now. You can retry it later.", [
      { text: "Keep running", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: () => void run("task.cancel", { id, confirmed: true }),
      },
    ]);
  const hold = state === "queued" || state === "blocked" ? holdText(task) : "";
  return (
    <View style={styles.stack}>
      {hold ? (
        <Txt v="meta" tone="muted">
          {hold}
        </Txt>
      ) : null}
      <ShippingContext task={task} />
      <KnowledgeContext task={task} />
      <SkillsContext task={task} online={online} />
      <ConnectionsContext task={task} online={online} />
      <BrowserContext task={task} online={online} />
      <WorktreeChanges task={task} online={online} />
      {state === "running" ? (
        <Button
          label="Stop task"
          disabled={!online || busy}
          onPress={stop}
          a11y={`Stop ${text(task.title)}`}
        />
      ) : null}
      {state === "failed" ? (
        <Button
          label="Retry"
          kind="primary"
          disabled={!online || busy}
          onPress={() => void run("task.retry", { id })}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ stack: { gap: 10 } });
