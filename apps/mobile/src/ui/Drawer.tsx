import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import {
  channelRows,
  drawerChats,
  drawerPeople,
  drawerProjects,
  matches,
  type PersonRow,
  resolveProject,
  taskStateWord,
} from "../data/drawer";
import { needsYouTasks, type TaskView, taskAge, taskViews } from "../data/tasks";
import type { Row } from "../data/transport";
import { useDrawer } from "../state/drawer";
import { useCall, useClient, useSnapshot } from "../state/link";
import { sans, touch, useTheme } from "../theme";
import { BotAvatar } from "./BotAvatar";
import { Icon } from "./icons";
import { Txt } from "./kit";
import { pick } from "./SessionControls";

const glyphs = {
  menu: "M4 8h16 M4 16h16",
  hash: "M5 9h14 M5 15h14 M10 4 8 20 M16 4l-2 16",
  search: "M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z M20 20l-4-4",
  compose: "M4 20h4L19 9l-4-4L4 16Z",
} as const;
function Glyph({
  name,
  color,
  size = 20,
}: {
  name: keyof typeof glyphs;
  color: string;
  size?: number;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      accessible={false}
      pointerEvents="none"
    >
      <Path
        d={glyphs[name]}
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** A round 44pt icon button, the shape the drawer's header and footer use. */
function RoundIcon({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: c["bg-raised"], borderColor: c.border },
        pressed && { backgroundColor: c["bg-active"] },
      ]}
    >
      {children}
    </Pressable>
  );
}

/** Opens the drawer from the top left of Home and Tasks. */
export function MenuButton() {
  const { c } = useTheme();
  const set = useDrawer((state) => state.set);
  return (
    <RoundIcon label="Open menu" onPress={() => set({ open: true })}>
      <Glyph name="menu" color={c.text} />
    </RoundIcon>
  );
}

function Badge({ count, tone }: { count: number; tone: "attention" | "neutral" }) {
  const { c } = useTheme();
  if (!count) return null;
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: tone === "attention" ? c.attention : c["bg-active"] },
      ]}
    >
      <Txt v="chip" style={{ color: tone === "attention" ? c["bg-page"] : c.text }}>
        {String(count)}
      </Txt>
    </View>
  );
}

function Item({
  label,
  onPress,
  children,
  expanded,
  sub,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
  expanded?: boolean;
  sub?: boolean;
}) {
  const { c } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(expanded === undefined ? {} : { accessibilityState: { expanded } })}
      style={({ pressed }) => [
        sub ? styles.sub : styles.item,
        pressed && { backgroundColor: c["bg-active"] },
      ]}
    >
      {children}
    </Pressable>
  );
}

function Label({ title }: { title: string }) {
  return (
    <Txt v="chip" tone="muted" accessibilityRole="header" style={styles.label}>
      {title}
    </Txt>
  );
}

function TaskDot({ state }: { state: string }) {
  const { c } = useTheme();
  const color =
    state === "review"
      ? c.attention
      : state === "failed"
        ? c.danger
        : state === "running"
          ? c["accent-text"]
          : c["text-muted"];
  return state === "queued" ? (
    <View style={[styles.dot, styles.hollow, { borderColor: color }]} />
  ) : (
    <View style={[styles.dot, { backgroundColor: color }]} />
  );
}

function Person({ person, go }: { person: PersonRow; go: (threadId: string | null) => void }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const many = person.tasks.length > 1;
  const subTail = (task: TaskView) =>
    task.state === "running" ? taskAge(task.updatedAt) : taskStateWord(task.state);
  return (
    <View>
      <Item
        label={[person.name, person.meta].filter(Boolean).join(", ")}
        onPress={() => (many ? setOpen(!open) : go(person.threadId))}
        {...(many ? { expanded: open } : {})}
      >
        <BotAvatar id={person.avatarId} size={28} />
        <View style={styles.flex}>
          <Txt lines={1}>{person.name}</Txt>
          {person.meta ? (
            <Txt v="meta" tone="muted" lines={1}>
              {person.meta}
            </Txt>
          ) : null}
        </View>
        {many ? <Icon name={open ? "down" : "chevron"} size={16} color={c["text-muted"]} /> : null}
      </Item>
      {many && open
        ? person.tasks.map((task) => (
            <Item
              key={task.id}
              sub
              label={`${task.title}, ${taskStateWord(task.state)}`}
              onPress={() => go(task.threadId)}
            >
              <TaskDot state={task.state} />
              <Txt tone="secondary" lines={1} style={styles.flex}>
                {task.title}
              </Txt>
              <Txt v="meta" tone="muted">
                {subTail(task)}
              </Txt>
            </Item>
          ))
        : null}
    </View>
  );
}

const chatLimit = 8;

/**
 * The side menu: the project, its Tasks with what needs you, its channels, its people and its
 * chats. Channels come from `channel.list`, refreshed each time the menu opens and whenever the
 * project's teams or managers change.
 */
export function Drawer() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { open, projectId, set } = useDrawer();
  const snapshot = useSnapshot();
  const call = useCall();
  const online = useClient((state) => state.status === "online");
  const [listed, setListed] = useState<Row[] | null>(null);
  const [query, setQuery] = useState("");
  const slide = useRef(new Animated.Value(0)).current;
  const [shown, setShown] = useState(open);

  const projects = drawerProjects(snapshot);
  const project = resolveProject(snapshot, projectId);
  const projectName = projects.find((row) => row.id === project)?.name ?? "";
  const views = useMemo(() => taskViews(snapshot), [snapshot]);
  const changes = useMemo(
    () =>
      JSON.stringify([
        (snapshot.entities.subproject ?? []).map((row) => [row.id, row.archived]),
        (snapshot.entities.thread ?? [])
          .filter((row) => row.kind === "manager")
          .map((row) => [row.id, row.archived]),
        (snapshot.entities.channel ?? []).map((row) => [row.id, row.updatedAt]),
      ]),
    [snapshot],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `changes` refetches when teams or managers change
  useEffect(() => {
    if (!open || !online) return;
    let current = true;
    call("channel.list", project ? { projectId: project } : {})
      .then((result) => {
        if (current) setListed(((result as { items?: Row[] }).items ?? []) as Row[]);
      })
      .catch(() => {
        if (current) setListed(null);
      });
    return () => {
      current = false;
    };
  }, [open, online, project, call, changes]);

  useEffect(() => {
    let current = true;
    if (open) setShown(true);
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (!current) return;
      const to = open ? 1 : 0;
      const done = () => {
        if (current && !open) setShown(false);
      };
      if (reduced) {
        slide.setValue(to);
        done();
        return;
      }
      Animated.timing(slide, { toValue: to, duration: 220, useNativeDriver: true }).start(done);
    });
    return () => {
      current = false;
    };
  }, [open, slide]);

  const close = () => {
    set({ open: false });
    setQuery("");
  };
  const go = (href: Parameters<typeof router.push>[0]) => {
    close();
    router.push(href);
  };
  const openThread = (threadId: string | null) => {
    if (threadId) go(`/chat/${encodeURIComponent(threadId)}`);
  };
  const switchProject = () =>
    pick(
      "Project",
      undefined,
      projects.map((row) => row.name),
      (index) => set({ projectId: projects[index]?.id ?? null }),
    );

  const channels = channelRows(
    listed ?? snapshot.entities.channel ?? [],
    snapshot.entities.channelRequest ?? [],
    project,
  ).filter((row) => matches(query, row.name));
  const people = drawerPeople(snapshot, project, views).filter((row) =>
    matches(query, row.name, ...row.tasks.map((task) => task.title)),
  );
  const chats = drawerChats(snapshot, project).filter((row) => matches(query, row.title));
  const needs = needsYouTasks(snapshot, project);

  return (
    <Modal visible={shown} transparent animationType="none" onRequestClose={close}>
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.panel,
          {
            backgroundColor: c["bg-page"],
            paddingTop: insets.top + 10,
            transform: [
              { translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] }) },
            ],
          },
        ]}
      >
        <View style={styles.header}>
          {projects.length > 1 ? (
            <Pressable
              onPress={switchProject}
              accessibilityRole="button"
              accessibilityLabel={`${projectName}, switch project`}
              style={styles.project}
            >
              <Txt v="cardTitle" lines={1} style={styles.shrink}>
                {projectName}
              </Txt>
              <Icon name="down" size={16} color={c["text-muted"]} stroke={2} />
            </Pressable>
          ) : (
            <Txt v="cardTitle" lines={1} accessibilityRole="header" style={styles.shrink}>
              {projectName}
            </Txt>
          )}
          <RoundIcon label="Close menu" onPress={close}>
            <Icon name="chevron" size={20} color={c.text} stroke={1.8} />
          </RoundIcon>
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {projects.length === 0 ? (
            <Txt tone="muted" style={styles.label}>
              Add a repo on Home to see its people and channels here.
            </Txt>
          ) : null}
          <Item label={needs ? `Tasks, ${needs} need you` : "Tasks"} onPress={() => go("/tasks")}>
            <Icon name="task" size={22} color={c.text} stroke={1.8} />
            <Txt style={styles.flex}>Tasks</Txt>
            <Badge count={needs} tone="attention" />
          </Item>

          {channels.length ? <Label title="Channels" /> : null}
          {channels.map((channel) => (
            <Item
              key={channel.id}
              label={
                channel.active
                  ? `${channel.name} channel, ${channel.active} open ${channel.active === 1 ? "request" : "requests"}`
                  : `${channel.name} channel`
              }
              onPress={() => go({ pathname: "/channel/[id]", params: { id: channel.id } })}
            >
              <Glyph name="hash" color={c["text-secondary"]} />
              <Txt v={channel.active ? "bodyMedium" : "body"} lines={1} style={styles.flex}>
                {channel.name}
              </Txt>
              <Badge count={channel.active} tone="neutral" />
            </Item>
          ))}

          {people.length ? <Label title="People" /> : null}
          {people.map((person) => (
            <Person key={person.key} person={person} go={(id) => openThread(id)} />
          ))}

          {chats.length ? <Label title="Chats" /> : null}
          {chats.slice(0, chatLimit).map((chat) => (
            <Item key={chat.threadId} label={chat.title} onPress={() => openThread(chat.threadId)}>
              <Txt lines={1} style={styles.flex}>
                {chat.title}
              </Txt>
              <Txt v="meta" tone="muted">
                {chat.age}
              </Txt>
            </Item>
          ))}
          {chats.length > chatLimit ? (
            <Item label="All chats" onPress={() => go("/chats")}>
              <Txt tone="accent">All chats</Txt>
            </Item>
          ) : null}
          {query.trim() && !channels.length && !people.length && !chats.length ? (
            <Txt tone="muted" style={styles.label}>
              Nothing matches “{query.trim()}”.
            </Txt>
          ) : null}
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + 10 }]}>
          <View style={[styles.search, { backgroundColor: c["bg-raised"], borderColor: c.border }]}>
            <Glyph name="search" color={c["text-muted"]} size={18} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search"
              placeholderTextColor={c["text-muted"]}
              accessibilityLabel="Search channels, people and chats"
              returnKeyType="search"
              clearButtonMode="while-editing"
              style={[styles.input, { color: c.text, fontFamily: sans }]}
            />
          </View>
          <RoundIcon label="Settings" onPress={() => go("/settings")}>
            <Icon name="settings" size={20} color={c.text} stroke={1.8} />
          </RoundIcon>
          <RoundIcon label="New chat" onPress={() => go("/new")}>
            <Glyph name="compose" color={c.text} />
          </RoundIcon>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  project: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: touch, flexShrink: 1 },
  shrink: { flexShrink: 1 },
  body: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 16 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: touch,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 12,
  },
  sub: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: touch,
    paddingStart: 48,
    paddingEnd: 8,
    borderRadius: 12,
  },
  label: { marginTop: 18, marginBottom: 4, marginHorizontal: 8 },
  flex: { flex: 1, minWidth: 0 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  hollow: { borderWidth: 1.5 },
  badge: {
    minWidth: 20,
    minHeight: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  round: {
    width: touch,
    height: touch,
    borderRadius: touch / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  search: {
    flex: 1,
    minHeight: touch,
    borderRadius: touch / 2,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
  },
  input: { flex: 1, fontSize: 15, paddingVertical: 10 },
});
