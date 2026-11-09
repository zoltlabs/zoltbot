import { threadResults } from "@zoltbot/ui/chat/results-data";
import { waitingState } from "@zoltbot/ui/chat/waiting-state";
import { router } from "expo-router";
import { View } from "react-native";
import { text } from "../data/view";
import { useAction } from "../state/actions";
import { useClient, useSnapshot } from "../state/link";
import { Button, Card, Txt } from "./kit";

export function ChatWaiting({ threadId }: { threadId: string }) {
  const snapshot = useSnapshot();
  const status = useClient((s) => s.status);
  const waiting = waitingState(snapshot.entities, threadId, status);
  return (
    <View accessibilityLiveRegion="polite">
      {waiting ? (
        <Card>
          <Txt v="bodyMedium">{waiting.label}</Txt>
          <Txt tone="secondary">{waiting.description}</Txt>
        </Card>
      ) : null}
    </View>
  );
}
export function ChatOutcome({ threadId }: { threadId: string }) {
  const snapshot = useSnapshot();
  const status = useClient((s) => s.status);
  const { run, busy } = useAction();
  const data = threadResults(snapshot.entities, threadId);
  const thread = snapshot.entities.thread?.find((t) => t.id === threadId);
  if (
    !data.complete ||
    thread?.archived ||
    thread?.archiveWhenIdle ||
    waitingState(snapshot.entities, threadId, status)
  )
    return null;
  return (
    <Card label="Completed work">
      <Txt v="cardTitle">{data.task?.state === "review" ? "Ready to review" : "Turn complete"}</Txt>
      <Button
        label="View results"
        onPress={() => router.push(`/chat/results?id=${encodeURIComponent(threadId)}`)}
      />
      {data.task ? (
        <Button label="Review task" onPress={() => router.push("/(tabs)/tasks")} />
      ) : (
        <Button
          label={busy ? "Archiving…" : "Archive"}
          disabled={busy || status !== "online"}
          onPress={() => void run("thread.settle", { id: threadId })}
        />
      )}
      {data.task ? <Txt tone="secondary">{text(data.task.title)}</Txt> : null}
    </Card>
  );
}
