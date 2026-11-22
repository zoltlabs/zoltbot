import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { drawerProjects } from "../../data/drawer";
import {
  type FilterOption,
  filterOptions,
  filterTasks,
  groupTaskViews,
  type TaskGroup,
  type TaskView,
  taskAge,
  taskMeta,
  taskPill,
  taskViews,
} from "../../data/tasks";
import { currentResult, groupTitles, text } from "../../data/view";
import { useAction } from "../../state/actions";
import { useDrawer } from "../../state/drawer";
import { useClient, useSnapshot } from "../../state/link";
import { touch, useTheme } from "../../theme";
import { BotAvatar } from "../../ui/BotAvatar";
import { RoundButton, TabScreen } from "../../ui/chrome";
import { MenuButton } from "../../ui/Drawer";
import { Icon } from "../../ui/icons";
import { Button, Chip, Group, Section, showPrompt, Txt } from "../../ui/kit";
import { pick } from "../../ui/SessionControls";

const openThread = (task: TaskView) => {
  if (task.documentPath) router.push(`/document/${encodeURIComponent(task.id)}`);
  else if (task.threadId) router.push(`/chat/${encodeURIComponent(task.threadId)}`);
};

/** A pill that opens a list of choices, like "All teams". */
function FilterChip({
  label,
  title,
  all,
  options,
  value,
  onChange,
}: {
  label: string;
  title: string;
  all: string;
  options: FilterOption[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { c } = useTheme();
  const current = options.find((option) => option.id === value)?.name ?? all;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${current}`}
      hitSlop={6}
      onPress={() =>
        pick(title, undefined, [all, ...options.map((option) => option.name)], (index) =>
          onChange(index === 0 ? null : (options[index - 1]?.id ?? null)),
        )
      }
      style={({ pressed }) => [
        styles.filter,
        { backgroundColor: pressed ? c["bg-active"] : c["bg-raised"], borderColor: c.border },
      ]}
    >
      <Txt v="chip">{current}</Txt>
      <Icon name="down" size={14} color={c["text-muted"]} stroke={2} />
    </Pressable>
  );
}

function TaskRow({ task, last, online }: { task: TaskView; last: boolean; online: boolean }) {
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const { run, busy } = useAction();
  const pill = taskPill(task.state);
  const needsYou = task.state === "review" || task.state === "failed";
  const raw = snapshot.entities.task?.find((row) => row.id === task.id);
  const summary =
    task.state === "review" && raw
      ? text(currentResult(raw, snapshot.entities.taskResult ?? [])?.summary)
      : "";
  const detail = task.reason || summary;
  const review = (decision: "accept" | "changes", feedback?: string) =>
    run("task.review", {
      id: task.id,
      revision: task.revision,
      decision,
      ...(feedback ? { feedback } : {}),
      confirmed: true,
    });
  const sendBack = () =>
    showPrompt({
      title: "Send back",
      message: "What should change?",
      confirmLabel: "Send back",
      optional: true,
      onSubmit: (value) => void review("changes", value || undefined),
    });
  const meta = needsYou ? taskMeta(task, Date.now(), false) : taskMeta(task);
  const age = taskAge(task.updatedAt);
  return (
    <Pressable
      onPress={() => openThread(task)}
      disabled={!task.threadId && !task.documentPath}
      accessibilityRole="button"
      accessibilityLabel={[
        task.title,
        meta,
        pill?.label,
        needsYou ? detail : "",
        needsYou ? age : "",
      ]
        .filter(Boolean)
        .join(", ")}
      style={({ pressed }) => [
        styles.row,
        needsYou ? styles.top : styles.center,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
        pressed && { backgroundColor: c["bg-active"] },
      ]}
    >
      <BotAvatar id={task.ownerId ?? task.id} size={28} />
      <View style={styles.text}>
        <View style={styles.titleLine}>
          <Txt v="bodyMedium" lines={2} style={styles.flex}>
            {task.title}
          </Txt>
          {needsYou && age ? (
            <Txt v="meta" tone="muted">
              {age}
            </Txt>
          ) : null}
        </View>
        <Txt v="meta" tone="muted" lines={needsYou ? 1 : 2}>
          {meta}
        </Txt>
        {needsYou && pill ? (
          <View style={styles.reason}>
            <Chip label={pill.label} tone={pill.tone} />
            {detail ? (
              <Txt v="meta" tone="muted" lines={1} style={styles.flex}>
                {detail}
              </Txt>
            ) : null}
          </View>
        ) : null}
        {task.state === "review" ? (
          <View style={styles.actions}>
            <Button
              label="Accept"
              kind="primary"
              a11y={`Accept ${task.title}`}
              disabled={!online || busy}
              onPress={() => void review("accept")}
            />
            <Button
              label="Send back"
              a11y={`Send back ${task.title}`}
              disabled={!online || busy}
              onPress={sendBack}
            />
          </View>
        ) : null}
      </View>
      {!needsYou && pill ? <Chip label={pill.label} tone={pill.tone} /> : null}
    </Pressable>
  );
}

const doneLabels: Record<string, string> = { completed: "Accepted", cancelled: "Stopped" };

export default function Tasks() {
  const { c } = useTheme();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const projectId = useDrawer((state) => state.projectId);
  const setDrawer = useDrawer((state) => state.set);
  const [teamId, setTeam] = useState<string | null>(null);
  const [ownerId, setOwner] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new project resets the filters
  useEffect(() => {
    setTeam(null);
    setOwner(null);
  }, [projectId]);

  const views = useMemo(() => taskViews(snapshot), [snapshot]);
  const projects = drawerProjects(snapshot);
  const inProject = filterTasks(views, { projectId });
  const visible = filterTasks(inProject, { teamId, ownerId });
  const groups = groupTaskViews(visible);
  const live: TaskGroup[] = ["needs_you", "running", "queued"];
  return (
    <TabScreen
      title="Tasks"
      left={<MenuButton />}
      right={<RoundButton label="New task" onPress={() => router.push("/new?mode=task")} />}
    >
      {views.length ? (
        <View style={styles.filters}>
          {projects.length > 1 ? (
            <FilterChip
              label="Project"
              title="Project"
              all="All projects"
              options={projects}
              value={projectId}
              onChange={(id) => setDrawer({ projectId: id })}
            />
          ) : null}
          <FilterChip
            label="Team"
            title="Team"
            all="All teams"
            options={filterOptions(inProject, "team")}
            value={teamId}
            onChange={setTeam}
          />
          <FilterChip
            label="Owner"
            title="Owner"
            all="Anyone"
            options={filterOptions(inProject, "owner")}
            value={ownerId}
            onChange={setOwner}
          />
        </View>
      ) : null}
      {visible.length === 0 ? (
        <Txt tone="muted" style={styles.empty}>
          {views.length
            ? "No tasks match these filters."
            : "No tasks yet. A task runs on its own and comes back for your review."}
        </Txt>
      ) : null}
      {live.map((key) =>
        groups[key].length ? (
          <View key={key}>
            <Section title={groupTitles[key]} count={groups[key].length} />
            <Group>
              {groups[key].map((task, index) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  online={online}
                  last={index === groups[key].length - 1}
                />
              ))}
            </Group>
          </View>
        ) : null,
      )}
      {groups.done.length ? (
        <Group>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${groupTitles.done}, ${groups.done.length}`}
            accessibilityState={{ expanded: showDone }}
            onPress={() => setShowDone(!showDone)}
            style={({ pressed }) => [
              styles.done,
              showDone && {
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: c.border,
              },
              pressed && { backgroundColor: c["bg-active"] },
            ]}
          >
            <Txt v="section" style={styles.flex}>
              {groupTitles.done}
              <Txt v="bodyMedium" tone="muted">{`  ${groups.done.length}`}</Txt>
            </Txt>
            <Icon
              name={showDone ? "down" : "chevron"}
              size={18}
              color={c["text-muted"]}
              stroke={2}
            />
          </Pressable>
          {showDone
            ? groups.done.map((task, index) => (
                <Pressable
                  key={task.id}
                  onPress={() => openThread(task)}
                  disabled={!task.threadId}
                  accessibilityRole="button"
                  accessibilityLabel={`${task.title}, ${doneLabels[task.state] ?? ""}, ${taskMeta(task)}`}
                  style={({ pressed }) => [
                    styles.row,
                    styles.center,
                    index < groups.done.length - 1 && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: c.border,
                    },
                    pressed && { backgroundColor: c["bg-active"] },
                  ]}
                >
                  <BotAvatar id={task.ownerId ?? task.id} size={28} />
                  <View style={styles.text}>
                    <Txt v="bodyMedium" lines={2}>
                      {task.title}
                    </Txt>
                    <Txt v="meta" tone="muted" lines={1}>
                      {taskMeta(task)}
                    </Txt>
                  </View>
                  {task.state === "cancelled" ? <Chip label="Stopped" /> : null}
                </Pressable>
              ))
            : null}
        </Group>
      ) : null}
      <Button kind="plain" label="Routines" onPress={() => router.push("/routines")} />
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  filters: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  filter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    minHeight: touch + 12,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  top: { alignItems: "flex-start" },
  center: { alignItems: "center" },
  text: { flex: 1, minWidth: 0, gap: 2 },
  titleLine: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  reason: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  done: {
    minHeight: touch + 8,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  empty: { marginHorizontal: 4 },
});
