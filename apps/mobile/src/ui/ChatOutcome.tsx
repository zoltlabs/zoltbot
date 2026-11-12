import { completionReceipt } from "@zoltbot/ui/chat/completion-data";
import { waitingState } from "@zoltbot/ui/chat/waiting-state";
import { router } from "expo-router";
import { View } from "react-native";
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
  const data = completionReceipt(snapshot.entities, threadId);
  const thread = snapshot.entities.thread?.find((t) => t.id === threadId);
  if (
    !data.visible ||
    thread?.archived ||
    thread?.archiveWhenIdle ||
    waitingState(snapshot.entities, threadId, status)
  )
    return null;
  return (
    <Card label="Completed work">
      <Txt v="bodyMedium">{data.summary}</Txt>
      <Button
        label={data.actionLabel}
        onPress={() =>
          router.push(
            data.action === "changes"
              ? `/chat/changes?id=${encodeURIComponent(threadId)}&turnId=${encodeURIComponent(String(data.latestTurn?.id ?? ""))}`
              : `/chat/results?id=${encodeURIComponent(threadId)}`,
          )
        }
      />
      {data.task ? (
        <Button kind="plain" label="Review task" onPress={() => router.push("/(tabs)/tasks")} />
      ) : null}
    </Card>
  );
}
