import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActionSheetIOS, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Attachment, composeInput } from "../data/attachments";
import { place, profiles, text } from "../data/view";
import { newId, useAction } from "../state/actions";
import { useClient, useSnapshot } from "../state/link";
import { sans, touch, useTheme } from "../theme";
import { Attachments } from "../ui/Attachments";
import { OfflineBanner } from "../ui/chrome";
import { Icon } from "../ui/icons";
import { Avatar, Button, Segmented, Txt } from "../ui/kit";

type Mode = "chat" | "task";

/** New chat or task: pick where and who, say what to do. Opened from the tab bar or a project. */
export default function NewWork() {
  const params = useLocalSearchParams<{ mode?: string; place?: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const kind = useClient((state) => state.kind);
  const { run, busy } = useAction();
  const directions = (snapshot.entities.subproject ?? []).filter((row) => row.archived !== true);
  const people = profiles(snapshot);
  const [mode, setMode] = useState<Mode>(params.mode === "task" ? "task" : "chat");
  const [where, setWhere] = useState(params.place ?? text(directions[0]?.id));
  const [who, setWho] = useState(text(people[0]?.id));
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [createdThreadId, setCreatedThreadId] = useState<string>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [doneWhen, setDoneWhen] = useState("");
  const task = mode === "task";
  const direction = directions.find((row) => row.id === where);
  const label = (row: (typeof directions)[number]) =>
    place(snapshot, { projectId: row.projectId, node: { type: "subproject", id: row.id } });
  const ready =
    online &&
    Boolean(
      direction &&
        who &&
        (message.trim() || (!task && attachments.length)) &&
        (!task || title.trim()),
    );

  const pickPlace = () => {
    const labels = directions.map(label);
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...labels, "Cancel"], cancelButtonIndex: labels.length, title: "Where" },
      (index) => {
        const row = directions[index];
        if (row) setWhere(text(row.id));
      },
    );
  };

  const start = async () => {
    if (!ready || !direction) return;
    const node = { type: "subproject", id: text(direction.id) } as const;
    if (task) {
      const created = await run("task.create", {
        title: title.trim(),
        brief: message.trim(),
        ...(doneWhen.trim() ? { acceptance: doneWhen.trim() } : {}),
        profileId: who,
        node,
      });
      if (created) {
        if (kind === "fake" && attachments.length) {
          const sent = await run("turn.send", {
            threadId: (created as { threadId: string }).threadId,
            input: composeInput("", attachments),
            mode: "queue",
          });
          if (!sent) return;
        }
        router.replace("/tasks");
      }
      return;
    }
    const at = new Date().toISOString();
    const id = createdThreadId ?? newId("thread");
    const created =
      createdThreadId ||
      (await run("thread.create", {
        value: {
          id,
          agentId: who,
          projectId: text(direction.projectId),
          node,
          kind: "side",
          title: message.trim().split(/\s+/).slice(0, 6).join(" ") || "New chat",
          titleSource: "auto",
          pinned: false,
          archived: false,
          createdAt: at,
          lastActivityAt: at,
        },
      }));
    if (!created) return;
    setCreatedThreadId(id);
    const sent = await run("turn.send", {
      threadId: id,
      input: composeInput(message, attachments),
      mode: "queue",
    });
    if (sent) router.replace(`/chat/${id}`);
  };

  const field = [
    styles.input,
    { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
  ];
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingBottom: insets.bottom }]}>
      <View style={styles.bar}>
        <Button
          kind="plain"
          label="Cancel"
          onPress={() => router.back()}
          style={styles.barButton}
        />
        <Txt v="cardTitle" accessibilityRole="header">
          {task ? "New task" : "New chat"}
        </Txt>
        <Button
          kind="plain"
          label="Start"
          disabled={!ready || busy}
          onPress={() => void start()}
          style={styles.barButton}
        />
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <OfflineBanner />
        <Segmented
          label="Kind"
          disabled={!online || busy || Boolean(createdThreadId)}
          value={mode}
          onChange={setMode}
          options={[
            { value: "chat", label: "Chat" },
            { value: "task", label: "Task" },
          ]}
        />
        <Txt v="meta" tone="muted" style={styles.note}>
          {task
            ? "Runs on its own in a fresh conversation and comes back for your review."
            : "Talk with an agent while it works, back and forth."}
        </Txt>
        <View style={[styles.group, { backgroundColor: c["bg-raised"], borderColor: c.border }]}>
          <Pressable
            disabled={!online || busy || Boolean(createdThreadId)}
            onPress={pickPlace}
            accessibilityRole="button"
            accessibilityLabel={`Where: ${direction ? label(direction) : "choose"}`}
            style={[
              styles.line,
              { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <Txt tone="muted" style={styles.key}>
              Where
            </Txt>
            <Txt style={styles.flex}>{direction ? label(direction) : "Choose"}</Txt>
            <Icon name="chevron" size={16} stroke={2} color={c["text-muted"]} />
          </Pressable>
          <View style={styles.line}>
            <Txt tone="muted" style={styles.key}>
              Profile
            </Txt>
            <View accessibilityRole="radiogroup" accessibilityLabel="Profile" style={styles.people}>
              {people.map((profile) => {
                const on = profile.id === who;
                return (
                  <Pressable
                    key={text(profile.id)}
                    disabled={!online || busy || Boolean(createdThreadId)}
                    onPress={() => setWho(text(profile.id))}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={text(profile.name)}
                    hitSlop={4}
                    style={[
                      styles.person,
                      {
                        borderColor: on ? c["accent-border"] : c["border-strong"],
                        backgroundColor: on ? c["accent-soft"] : "transparent",
                      },
                    ]}
                  >
                    <Avatar id={text(profile.id)} size={24} />
                    <Txt tone={on ? "accent" : "text"}>{text(profile.name)}</Txt>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
        {task ? (
          <View style={styles.labelled}>
            <Txt v="meta" tone="secondary">
              Title
            </Txt>
            <TextInput
              editable={online && !busy}
              value={title}
              onChangeText={setTitle}
              placeholder="Short name for the task"
              placeholderTextColor={c["text-dim"]}
              accessibilityLabel="Title"
              style={field}
            />
          </View>
        ) : null}
        <Attachments
          value={attachments}
          onChange={setAttachments}
          disabled={busy || (task && kind !== "fake")}
        />
        <View style={styles.labelled}>
          <Txt v="meta" tone="secondary">
            {task ? "Goal" : "Message"}
          </Txt>
          <TextInput
            editable={online && !busy}
            value={message}
            onChangeText={setMessage}
            placeholder={task ? "What should the agent do?" : "What do you want to work on?"}
            placeholderTextColor={c["text-dim"]}
            multiline
            accessibilityLabel={task ? "Goal" : "Message"}
            style={[...field, styles.area]}
          />
        </View>
        {task ? (
          <Txt v="meta" tone="muted">
            Task attachments use sample data only.
          </Txt>
        ) : null}
        {task ? (
          <View style={styles.labelled}>
            <Txt v="meta" tone="secondary">
              Done when (optional)
            </Txt>
            <TextInput
              editable={online && !busy}
              value={doneWhen}
              onChangeText={setDoneWhen}
              placeholder="How you will judge the result"
              placeholderTextColor={c["text-dim"]}
              accessibilityLabel="Done when"
              style={field}
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  barButton: { paddingHorizontal: 12 },
  body: { padding: 20, paddingTop: 8, gap: 16 },
  note: { marginTop: -6, marginHorizontal: 4 },
  group: { borderRadius: 14, borderWidth: 1 },
  line: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  key: { width: 64 },
  flex: { flex: 1 },
  people: { flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  person: {
    minHeight: touch,
    paddingLeft: 6,
    paddingRight: 12,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  labelled: { gap: 6 },
  input: {
    fontFamily: sans,
    minHeight: touch,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  area: { minHeight: 140, paddingTop: 12, textAlignVertical: "top", lineHeight: 22 },
});
