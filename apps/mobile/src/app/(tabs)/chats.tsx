import { chiefName } from "@zoltbot/ui/chief/data";
import { router } from "expo-router";
import { StyleSheet } from "react-native";
import { ago, chats, place, profileName, text } from "../../data/view";
import { useSnapshot } from "../../state/link";
import { useSharing } from "../../state/sharing";
import { TabScreen } from "../../ui/chrome";
import { Avatar, Button, Chip, Group, Row, Txt } from "../../ui/kit";

export default function Chats() {
  const snapshot = useSnapshot();
  const groups = snapshot.entities.compare ?? [];
  const grouped = new Set((snapshot.entities.compareMember ?? []).map((r) => r.threadId));
  const summaries = new Set(groups.map((r) => r.summaryThreadId));
  const list = chats(snapshot).filter(
    ({ thread }) => !grouped.has(thread.id) && !summaries.has(thread.id),
  );
  const draftCount = useSharing((state) => state.drafts.length);
  return (
    <TabScreen title="Chats">
      <Button label="Quick chat" kind="primary" onPress={() => router.push("/quick")} />
      <Button
        label={`Shared drafts${draftCount ? ` (${draftCount})` : ""}`}
        onPress={() => router.push("/shared")}
      />
      {groups.length ? (
        <Group>
          {groups.map((group, index) => (
            <Row
              key={text(group.id)}
              title={text(group.title) || "Compare"}
              meta={`Compare · ${text(group.state)}`}
              right={<Chip label="Read only" />}
              last={index === groups.length - 1}
              onPress={() => router.push(`/chat/compare/${text(group.id)}`)}
            />
          ))}
        </Group>
      ) : null}
      {list.length === 0 && groups.length === 0 ? (
        <Txt tone="muted" style={styles.empty}>
          No chats yet. Start one with New chat.
        </Txt>
      ) : (
        <Group>
          {list.map(({ thread, working, chief }, index) => (
            <Row
              key={text(thread.id)}
              title={chief ? chiefName(snapshot.entities) : text(thread.title)}
              meta={
                chief
                  ? "Your main agent"
                  : [
                      thread.taskId ? "Task" : "Chat",
                      profileName(snapshot, thread.agentId),
                      place(snapshot, thread),
                    ]
                      .filter(Boolean)
                      .join(" · ")
              }
              left={<Avatar id={text(thread.agentId)} />}
              right={
                working ? (
                  <Chip label="Working" tone="accent" dot />
                ) : (
                  <Txt v="meta" tone="muted">
                    {ago(thread.lastActivityAt)}
                  </Txt>
                )
              }
              last={index === list.length - 1}
              onPress={() => router.push(`/chat/${text(thread.id)}`)}
            />
          ))}
        </Group>
      )}
    </TabScreen>
  );
}

const styles = StyleSheet.create({ empty: { marginHorizontal: 4 } });
