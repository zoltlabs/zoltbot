import { chiefThreadId } from "@zoltbot/ui/chief/data";
import { router, useLocalSearchParams } from "expo-router";
import { View } from "react-native";
import { modelState, threadSession } from "../../data/session";
import { text } from "../../data/view";
import { useClient, useSnapshot } from "../../state/link";
import { DetailScreen } from "../../ui/DetailScreen";
import { Button, Txt } from "../../ui/kit";
import { BackgroundChip, ModeChip, ModelChip } from "../../ui/SessionControls";

/** Secondary controls live here so the conversation and its draft keep their space. */
export default function ChatOptions() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const session = threadSession(snapshot, id);
  const compareMember = snapshot.entities.compareMember?.find((member) => member.threadId === id);
  const readOnly =
    compareMember?.ceiling === "read_only" ||
    snapshot.entities.compare?.some((group) => group.summaryThreadId === id);
  const chief = chiefThreadId(snapshot.entities) === id;
  const wake = snapshot.entities.wake?.find(
    (row) =>
      row.threadId === id &&
      ["draft", "waiting", "ready", "needs_attention"].includes(text(row.status)),
  );
  const open = (screen: string) => router.replace(`/chat/${screen}?id=${encodeURIComponent(id)}`);
  return (
    <DetailScreen title="Chat options">
      {!readOnly ? (
        <View style={{ gap: 12 }}>
          <Txt v="section" accessibilityRole="header">
            Coding tool
          </Txt>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            <ModeChip session={session} online={online} />
            <ModelChip state={modelState(snapshot, session)} online={online} />
            <BackgroundChip session={session} />
          </View>
        </View>
      ) : (
        <Txt tone="secondary">Read-only comparison</Txt>
      )}
      <Button label="View results" onPress={() => open("results")} />
      <Button label="Review file changes" onPress={() => open("changes")} />
      <Button label="Open terminal" onPress={() => open("terminal")} />
      {!chief && !readOnly ? (
        <>
          <Button
            label={wake ? "Review wake condition" : "Wake when…"}
            disabled={!online}
            onPress={() =>
              router.replace(
                `/chat/wake?id=${encodeURIComponent(id)}${wake ? `&wakeId=${encodeURIComponent(text(wake.id))}` : ""}`,
              )
            }
          />
          <Button label="Fork chat" disabled={!online} onPress={() => open("fork")} />
        </>
      ) : null}
      {chief ? (
        <Button label="Brief and notifications" onPress={() => router.replace("/zolt-settings")} />
      ) : null}
    </DetailScreen>
  );
}
