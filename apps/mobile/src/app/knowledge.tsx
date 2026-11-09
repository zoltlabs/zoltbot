import { Value } from "@sinclair/typebox/value";
import { type KnowledgeItem, KnowledgeItemSchema } from "@zoltbot/protocol";
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { kindLabel } from "../data/manage";
import { text } from "../data/view";
import { useClient, useSnapshot } from "../state/link";
import { useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Button, Chip, Group, Row, Section, Txt } from "../ui/kit";

/** What every agent is told up front, by where it applies: you everywhere, or one project. */
export default function Knowledge() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const items = (snapshot.entities.knowledge ?? [])
    .filter((row): row is KnowledgeItem => Value.Check(KnowledgeItemSchema, row))
    .filter((item) => item.status !== "archived" && item.status !== "superseded");
  const scopeName = (item: KnowledgeItem) => {
    if (item.scope.type === "user") return "You";
    const kind = item.scope.type === "subproject" ? "subproject" : "project";
    return text(snapshot.entities[kind]?.find((row) => row.id === item.scope.id)?.name) || "Other";
  };
  const groups = new Map<string, KnowledgeItem[]>();
  for (const item of [...items].sort(
    (a, b) =>
      Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
      b.updatedAt.localeCompare(a.updatedAt),
  ))
    groups.set(scopeName(item), [...(groups.get(scopeName(item)) ?? []), item]);
  const names = [...groups.keys()].sort((a, b) =>
    a === "You" ? -1 : b === "You" ? 1 : a.localeCompare(b),
  );
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar
        label="Settings"
        right={
          <Button
            kind="plain"
            label="Add"
            a11y="Add knowledge"
            disabled={!online}
            onPress={() => router.push("/knowledge-edit")}
          />
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          Knowledge
        </Txt>
        <OfflineBanner />
        {items.length === 0 ? (
          <Txt tone="muted">Nothing yet. Add a decision or preference agents should know.</Txt>
        ) : null}
        {names.map((name) => {
          const rows = groups.get(name) ?? [];
          return (
            <View key={name} style={styles.group}>
              <Section title={name} count={rows.length} />
              <Group>
                {rows.map((item, index) => (
                  <Row
                    key={item.id}
                    title={item.title}
                    meta={`${kindLabel(item.kind)} · ${item.body.replace(/\s+/g, " ")}`}
                    right={
                      item.verification === "unverified" ? (
                        <Chip label="Agent" tone="accent" />
                      ) : undefined
                    }
                    onPress={() => router.push(`/knowledge-edit?id=${encodeURIComponent(item.id)}`)}
                    last={index === rows.length - 1}
                  />
                ))}
              </Group>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
  group: { gap: 8 },
});
