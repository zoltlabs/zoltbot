import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { workingStatus } from "../../data/status";
import { type TeamNode, teamTree } from "../../data/team-tree";
import { text, zolt } from "../../data/view";
import { useClient, useSnapshot } from "../../state/link";
import { touch, useTheme } from "../../theme";
import { BotAvatar } from "../../ui/BotAvatar";
import { TabScreen } from "../../ui/chrome";
import { MenuButton } from "../../ui/Drawer";
import { Icon } from "../../ui/icons";
import { Button, Group, Row, Section, Txt } from "../../ui/kit";

function Branch({ node, depth = 0, online }: { node: TeamNode; depth?: number; online: boolean }) {
  const snapshot = useSnapshot();
  const { c } = useTheme();
  const [open, setOpen] = useState(depth === 0);
  const repo = depth === 0;
  return (
    <View style={styles.branch}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={node.name}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [
          styles.branchRow,
          { backgroundColor: pressed ? c["bg-active"] : "transparent" },
        ]}
      >
        <Icon name={open ? "down" : "chevron"} size={16} color={c["text-muted"]} />
        <Icon name="folder" size={18} color={c["accent-text"]} />
        <Txt v={repo ? "cardTitle" : "bodyMedium"} style={styles.flex}>
          {node.name}
        </Txt>
      </Pressable>
      {open ? (
        <View style={[styles.children, { marginStart: depth < 2 ? c["space-3"] : c["space-1"] }]}>
          {node.projects.map((project) => (
            <Branch key={project.id} node={project} depth={depth + 1} online={online} />
          ))}
          {repo && node.employees.length ? (
            <Txt v="meta" tone="muted" style={styles.inset}>
              Repo chats
            </Txt>
          ) : null}
          {node.employees.map(({ thread, working }) => {
            const id = text(thread.id);
            const title = text(thread.title).trim() || "Chat";
            return (
              <Row
                key={id}
                title={title}
                titleLines={2}
                last
                label={working ? `${title}, working` : title}
                left={<BotAvatar id={id} working={working} />}
                detail={working ? (workingStatus(snapshot, id) ?? "Working") : undefined}
                onPress={() => router.push(`/chat/${encodeURIComponent(id)}`)}
              />
            );
          })}
          <View style={styles.actions}>
            <Button
              kind="plain"
              label={repo ? "Add project" : "Add employee"}
              a11y={repo ? `Add project to ${node.name}` : `Add employee to ${node.name}`}
              disabled={!online}
              onPress={() =>
                router.push(
                  repo
                    ? { pathname: "/project-sheet", params: { repoId: node.id } }
                    : {
                        pathname: "/new",
                        params: { mode: "employee", place: `subproject:${node.id}` },
                      },
                )
              }
            />
            {repo ? (
              <Button
                kind="plain"
                label="Details"
                a11y={`Details for ${node.name}`}
                onPress={() => router.push(`/projects/${encodeURIComponent(node.id)}`)}
              />
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default function Home() {
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const repos = useMemo(() => teamTree(snapshot), [snapshot]);
  const chief = zolt(snapshot);
  const threadId = chief.threadId;
  return (
    <TabScreen title="Home" left={<MenuButton />}>
      <Group>
        <Row
          title={chief.name}
          titleLines={2}
          last
          left={<BotAvatar id="zolt" zolt size={40} working={chief.working} />}
          detail={
            chief.working
              ? ((threadId ? workingStatus(snapshot, threadId) : undefined) ?? "Working")
              : threadId
                ? undefined
                : "Not set up"
          }
          disabled={!threadId && !online}
          onPress={() =>
            threadId
              ? router.push(`/chat/${encodeURIComponent(threadId)}`)
              : router.push({ pathname: "/new", params: { mode: "zolt" } })
          }
        />
      </Group>
      <Section
        title="Repos"
        right={
          <Button
            kind="plain"
            label="Add repo"
            disabled={!online}
            onPress={() => router.push("/project-sheet")}
          />
        }
      />
      {repos.length ? (
        repos.map((repo) => (
          <Group key={repo.id}>
            <Branch node={repo} online={online} />
          </Group>
        ))
      ) : (
        <Txt tone="muted">Add a repo to organize your projects and employees.</Txt>
      )}
      <Button kind="plain" label="All chats" onPress={() => router.push("/chats")} />
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  branch: { paddingVertical: 4 },
  branchRow: {
    minHeight: touch,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  flex: { flex: 1, minWidth: 0 },
  children: { gap: 2 },
  inset: { paddingHorizontal: 12, paddingTop: 8 },
  actions: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 4 },
});
