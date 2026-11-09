import { terms } from "@zoltbot/protocol";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Row as Entity } from "../../data/transport";
import {
  countsText,
  definitionName,
  directionRows,
  profiles,
  projectSummaries,
  text,
} from "../../data/view";
import { useClient, useSnapshot } from "../../state/link";
import { mono, useTheme } from "../../theme";
import { BackBar, OfflineBanner, RoundButton } from "../../ui/chrome";
import { Icon } from "../../ui/icons";
import { Avatar, Chip, Group, Row, Section, Txt } from "../../ui/kit";

export default function Projects() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((s) => s.status === "online");
  const projects = projectSummaries(snapshot);
  const people = profiles(snapshot);
  const openCount = (direction: Entity) => {
    const rows = directionRows(snapshot, text(direction.id)).filter(
      (entry) =>
        entry.type === "chat" || !["completed", "cancelled"].includes(text(entry.row.state)),
    );
    const tasks = rows.filter((entry) => entry.type === "task").length;
    const chats = rows.length - tasks;
    const parts = [
      tasks ? `${tasks} ${tasks === 1 ? "task" : "tasks"}` : "",
      chats ? `${chats} ${chats === 1 ? "chat" : "chats"}` : "",
    ].filter(Boolean);
    return parts.join(" · ") || "Nothing open";
  };
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
      <BackBar
        label="Overview"
        right={
          <RoundButton
            label={`New ${terms.workspace.one}`}
            disabled={!online}
            onPress={() => router.push("/project-sheet")}
          />
        }
      />
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]}>
        <Txt v="largeTitle" accessibilityRole="header" style={styles.title}>
          {terms.workspace.Many}
        </Txt>
        <OfflineBanner />
        {projects.map((project) => (
          <Group key={project.id}>
            <Pressable
              onPress={() => router.push(`/projects/${project.id}`)}
              accessibilityRole="button"
              accessibilityLabel={`${project.name}, ${project.path}, ${countsText(project.counts)}`}
              style={({ pressed }) => [
                styles.projectHead,
                { borderBottomColor: c.border },
                pressed && { backgroundColor: c["bg-active"] },
              ]}
            >
              <Icon name="folder" size={20} color={c["text-secondary"]} />
              <View style={styles.flex}>
                <Txt v="cardTitle">{project.name}</Txt>
                <Txt v="meta" tone="muted" style={styles.mono}>
                  {project.path}
                </Txt>
              </View>
              {project.counts.needsYou ? (
                <Chip label={`${project.counts.needsYou} needs you`} tone="attention" />
              ) : null}
            </Pressable>
            {project.directions.map((direction, index) => (
              <Row
                key={text(direction.id)}
                title={text(direction.name)}
                right={
                  <Txt v="meta" tone="muted">
                    {openCount(direction)}
                  </Txt>
                }
                last={index === project.directions.length - 1}
                onPress={() => router.push(`/projects/${project.id}`)}
              />
            ))}
          </Group>
        ))}
        <Section title={terms.profile.Many} />
        <Group>
          {people.map((profile, index) => (
            <Row
              key={text(profile.id)}
              title={text(profile.name)}
              meta={[definitionName(snapshot, profile.definitionId), text(profile.model)]
                .filter(Boolean)
                .join(" · ")}
              left={<Avatar id={text(profile.id)} />}
              right={<Icon name="chevron" size={16} stroke={2} color={c["text-muted"]} />}
              last={index === people.length - 1}
              onPress={() => router.push(`/profile/${text(profile.id)}`)}
              label={`Edit ${text(profile.name)}`}
            />
          ))}
        </Group>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { paddingHorizontal: 16, gap: 10 },
  title: { marginHorizontal: 4, marginBottom: 6 },
  projectHead: {
    minHeight: 60,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
  mono: { fontFamily: mono, fontSize: 12 },
});
