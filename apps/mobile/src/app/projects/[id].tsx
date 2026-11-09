import { terms } from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ago,
  directionRows,
  profileName,
  projectSummaries,
  taskStateLabel,
  text,
} from "../../data/view";
import { useClient, useSnapshot } from "../../state/link";
import { mono, touch, useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Icon } from "../../ui/icons";
import { Button, Chip, type ChipTone, Group, Row, Txt } from "../../ui/kit";

const tones: Record<string, ChipTone> = {
  review: "attention",
  running: "accent",
  completed: "ok",
  failed: "danger",
};

export default function Project() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((s) => s.status === "online");
  const project = projectSummaries(snapshot).find((row) => row.id === id);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  if (!project)
    return (
      <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
        <BackBar label={terms.workspace.Many} />
        <Txt tone="muted" style={styles.pad}>
          This {terms.workspace.one} is gone.
        </Txt>
      </View>
    );
  const { needsYou, running, queued } = project.counts;
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
      <BackBar
        label={terms.workspace.Many}
        right={
          <Button
            kind="plain"
            label="Edit"
            disabled={!online}
            onPress={() => router.push(`/project-sheet?id=${id}`)}
          />
        }
      />
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.head}>
          <Txt v="largeTitle" accessibilityRole="header">
            {project.name}
          </Txt>
          <Txt v="meta" tone="muted" style={styles.mono}>
            {project.path}
          </Txt>
          <View style={styles.chips}>
            {needsYou ? <Chip label={`${needsYou} needs you`} tone="attention" /> : null}
            {running ? <Chip label={`${running} running`} tone="accent" dot /> : null}
            {queued ? <Chip label={`${queued} queued`} /> : null}
          </View>
        </View>
        <OfflineBanner />
        {!project.directions.length ? (
          <Txt v="meta" tone="muted">
            Add {terms.team.many} on your Mac to start work in this {terms.workspace.one}.
          </Txt>
        ) : null}
        {project.directions.map((direction) => {
          const directionId = text(direction.id);
          const name = text(direction.name);
          const open = !closed[directionId];
          const entries = directionRows(snapshot, directionId);
          return (
            <View key={directionId} style={styles.section} accessibilityLabel={name}>
              <View style={styles.sectionHead}>
                <Pressable
                  onPress={() => setClosed({ ...closed, [directionId]: open })}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  accessibilityLabel={name}
                  style={styles.toggle}
                >
                  <View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
                    <Icon name="down" size={16} stroke={2} color={c["text-muted"]} />
                  </View>
                  <Txt v="section">{name}</Txt>
                </Pressable>
                <Pressable
                  disabled={!online}
                  onPress={() => router.push(`/new?mode=chat&place=${directionId}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`New ${terms.chat.one} in ${name}`}
                  style={styles.icon}
                >
                  <Icon name="newChat" size={20} color={c["accent-text"]} />
                </Pressable>
                <Pressable
                  disabled={!online}
                  onPress={() => router.push(`/new?mode=task&place=${directionId}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`New ${terms.task.one} in ${name}`}
                  style={styles.icon}
                >
                  <Icon name="newTask" size={20} color={c["accent-text"]} />
                </Pressable>
              </View>
              {open && entries.length === 0 ? (
                <Txt v="meta" tone="muted" style={styles.empty}>
                  Nothing here yet.
                </Txt>
              ) : null}
              {open && entries.length ? (
                <Group>
                  {entries.map((entry, index) => {
                    const row = entry.row;
                    const isTask = entry.type === "task";
                    const threadId = isTask ? text(row.threadId) : text(row.id);
                    const who = profileName(snapshot, isTask ? row.ownerAgentId : row.agentId);
                    return (
                      <Row
                        key={`${entry.type}-${text(row.id)}`}
                        title={text(row.title)}
                        meta={`${isTask ? "Task" : "Chat"} · ${who} · ${ago(entry.at)}`}
                        left={
                          <Icon
                            name={isTask ? "task" : "chats"}
                            size={16}
                            stroke={1.8}
                            color={c["text-muted"]}
                          />
                        }
                        right={
                          isTask ? (
                            <Chip
                              label={taskStateLabel(row)}
                              tone={tones[text(row.state)] ?? "neutral"}
                            />
                          ) : undefined
                        }
                        last={index === entries.length - 1}
                        onPress={() =>
                          isTask && !threadId
                            ? router.navigate("/tasks")
                            : router.push(`/chat/${threadId}`)
                        }
                      />
                    );
                  })}
                </Group>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  pad: { padding: 20 },
  body: { paddingHorizontal: 16, gap: 14 },
  head: { marginHorizontal: 4, gap: 4 },
  mono: { fontFamily: mono, fontSize: 12 },
  chips: { flexDirection: "row", gap: 6, marginTop: 6, flexWrap: "wrap" },
  section: { gap: 6 },
  sectionHead: { flexDirection: "row", alignItems: "center" },
  toggle: {
    flex: 1,
    minHeight: touch,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingLeft: 4,
  },
  icon: { width: touch, height: touch, alignItems: "center", justifyContent: "center" },
  empty: { marginHorizontal: 4 },
});
