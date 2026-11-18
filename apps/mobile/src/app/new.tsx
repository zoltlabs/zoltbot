import { terms } from "@zoltbot/protocol";
import { chiefDefaultProfile, chiefKeys, chiefName, chiefThreadId } from "@zoltbot/ui/chief/data";
import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Attachment, composeInput } from "../data/attachments";
import {
  type DispatchPlace,
  defaultProfileForPlace,
  deriveTaskTitle,
  dispatchGroups,
  profiles,
  resolvePlace,
  text,
} from "../data/view";
import { newId, useAction } from "../state/actions";
import { useClient, useLink, useSnapshot } from "../state/link";
import { sans, touch, useTheme } from "../theme";
import { Attachments } from "../ui/Attachments";
import { OfflineBanner } from "../ui/chrome";
import { Icon } from "../ui/icons";
import { Avatar, Button, Row, Segmented, Txt } from "../ui/kit";

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
  const groups = dispatchGroups(snapshot);
  const people = profiles(snapshot);
  const [mode, setMode] = useState<Mode>(params.mode === "task" ? "task" : "chat");
  const [whereKey, setWhereKey] = useState(
    () => resolvePlace(snapshot, groups, params.place)?.key ?? "",
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerProjectId, setPickerProjectId] = useState<string>();
  const userPickedProfile = useRef(false);
  const [pickedProfileId, setPickedProfileId] = useState("");
  const [message, setMessage] = useState("");
  const [createdThreadId, setCreatedThreadId] = useState<string>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [showDoneWhen, setShowDoneWhen] = useState(false);
  const [doneWhen, setDoneWhen] = useState("");

  const chief = params.mode === "zolt";
  const employee = params.mode === "employee";
  const task = mode === "task" && !chief && !employee;
  const name = chiefName(snapshot.entities);
  const resolved = resolvePlace(snapshot, groups, whereKey || params.place);
  const selectedPlace = employee && resolved?.key !== params.place ? undefined : resolved;
  const who =
    userPickedProfile.current && people.some((profile) => text(profile.id) === pickedProfileId)
      ? pickedProfileId
      : chief
        ? (chiefDefaultProfile(snapshot.entities) ?? "")
        : defaultProfileForPlace(snapshot, selectedPlace);
  const derivedTitle = deriveTaskTitle(message);
  const locked = !online || busy || Boolean(createdThreadId);
  const ready =
    online &&
    Boolean(
      who &&
        (chief ||
          (selectedPlace &&
            (employee
              ? message.trim()
              : task
                ? derivedTitle
                : message.trim() || attachments.length))),
    );

  const choosePlace = (place: DispatchPlace) => {
    setWhereKey(place.key);
    setPickerOpen(false);
    setPickerProjectId(undefined);
  };

  const togglePicker = () => {
    if (pickerOpen) {
      setPickerOpen(false);
      setPickerProjectId(undefined);
      return;
    }
    setPickerProjectId(undefined);
    setPickerOpen(true);
  };

  const start = async () => {
    if (!ready) return;
    const current = useLink.getState().client?.getState().snapshot ?? snapshot;
    const existing = chief ? chiefThreadId(current.entities) : undefined;
    if (existing) {
      router.replace(`/chat/${existing}`);
      return;
    }
    const { node, projectId } = selectedPlace ?? {};
    if (!chief && !node) return;
    if (task) {
      const created = await run("task.create", {
        title: derivedTitle,
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
      (await run(
        "thread.create",
        {
          value: {
            id,
            agentId: who,
            ...(chief ? {} : { projectId, node }),
            kind: chief ? "main" : "side",
            title: chief ? name : employee ? message.trim() : derivedTitle || "New chat",
            titleSource: chief || employee ? "human" : "auto",
            pinned: false,
            archived: false,
            createdAt: at,
            lastActivityAt: at,
          },
        },
        {
          key: JSON.stringify([
            "create-chat",
            params.mode,
            who,
            node,
            message,
            attachments.map((attachment) => attachment.id),
          ]),
        },
      ));
    if (!created) return;
    const savedId = createdThreadId ?? (text((created as { id?: string }).id) || id);
    setCreatedThreadId(savedId);
    if (chief) {
      const value = current.entities.settings?.find((row) => row.key === chiefKeys.thread)?.value;
      const result = await run("settings.set", {
        key: chiefKeys.thread,
        value: savedId,
        expected: value === undefined ? {} : { value },
      });
      if (!result) return;
    }
    if (chief || employee) {
      router.replace(`/chat/${savedId}`);
      return;
    }
    const sent = await run("turn.send", {
      threadId: savedId,
      input: composeInput(message, attachments),
      mode: "queue",
    });
    if (sent) router.replace(`/chat/${savedId}`);
  };

  const drilledGroup = pickerProjectId
    ? groups.find((group) => group.projectId === pickerProjectId)
    : undefined;
  const field = [
    styles.input,
    { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-raised"] },
  ];
  const whereLabel = selectedPlace
    ? selectedPlace.fullLabel
    : groups.length
      ? "Choose"
      : `No ${terms.workspace.many}`;

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
          {chief ? `Set up ${name}` : employee ? "Add employee" : task ? "New task" : "New chat"}
        </Txt>
        <Button
          kind="plain"
          label={employee ? "Add" : "Start"}
          disabled={!ready || busy}
          onPress={() => void start()}
          style={styles.barButton}
        />
      </View>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        <OfflineBanner />
        {people.length === 0 ? (
          <Txt tone="muted">Set up a coding profile on your Mac first.</Txt>
        ) : null}
        {!chief && !employee ? (
          <Segmented
            label="Kind"
            disabled={locked}
            value={mode}
            onChange={setMode}
            options={[
              { value: "chat", label: "Chat" },
              { value: "task", label: "Task" },
            ]}
          />
        ) : null}
        <View style={[styles.group, { backgroundColor: c["bg-raised"], borderColor: c.border }]}>
          {!chief ? (
            <>
              <Pressable
                disabled={locked || employee || !groups.length}
                onPress={togglePicker}
                accessibilityRole="button"
                accessibilityState={{
                  expanded: pickerOpen,
                  disabled: locked || employee || !groups.length,
                }}
                accessibilityLabel={`Where: ${whereLabel}`}
                style={[
                  styles.line,
                  { borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth },
                ]}
              >
                <Txt tone="muted" style={styles.key}>
                  Where
                </Txt>
                <Txt style={styles.flex}>{whereLabel}</Txt>
                <View style={{ transform: [{ rotate: pickerOpen ? "90deg" : "0deg" }] }}>
                  <Icon name="chevron" size={16} stroke={2} color={c["text-muted"]} />
                </View>
              </Pressable>
              {pickerOpen && groups.length ? (
                <View
                  style={{
                    backgroundColor: c["bg-sunken"],
                    borderBottomColor: c.border,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                  }}
                >
                  {drilledGroup ? (
                    <>
                      <Row
                        title={terms.workspace.Many}
                        left={<Icon name="back" size={16} stroke={2} color={c["accent-text"]} />}
                        label={`Back to ${terms.workspace.many}`}
                        onPress={() => setPickerProjectId(undefined)}
                      />
                      <Row
                        title={`All of ${drilledGroup.name}`}
                        {...(drilledGroup.path ? { meta: drilledGroup.path, mono: true } : {})}
                        checked={selectedPlace?.key === drilledGroup.root.key}
                        right={
                          selectedPlace?.key === drilledGroup.root.key ? (
                            <Icon name="check" size={18} stroke={2} color={c["accent-text"]} />
                          ) : undefined
                        }
                        last={!drilledGroup.teams.length}
                        onPress={() => choosePlace(drilledGroup.root)}
                      />
                      {drilledGroup.teams.map((team, index) => {
                        const on = selectedPlace?.key === team.key;
                        return (
                          <Row
                            key={team.key}
                            title={team.label}
                            checked={on}
                            right={
                              on ? (
                                <Icon name="check" size={18} stroke={2} color={c["accent-text"]} />
                              ) : undefined
                            }
                            last={index === drilledGroup.teams.length - 1}
                            onPress={() => choosePlace(team)}
                          />
                        );
                      })}
                    </>
                  ) : (
                    groups.map((group, index) => {
                      const meta = group.teams.length
                        ? [
                            group.path,
                            `${group.teams.length} ${group.teams.length === 1 ? terms.team.one : terms.team.many}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : group.path;
                      const on = group.directSelect && selectedPlace?.key === group.root.key;
                      return (
                        <Row
                          key={group.projectId}
                          title={group.name}
                          {...(meta ? { meta, mono: !group.teams.length } : {})}
                          {...(group.directSelect ? { checked: on } : {})}
                          right={
                            group.directSelect ? (
                              on ? (
                                <Icon name="check" size={18} stroke={2} color={c["accent-text"]} />
                              ) : undefined
                            ) : (
                              <Icon name="chevron" size={16} stroke={2} color={c["text-muted"]} />
                            )
                          }
                          last={index === groups.length - 1}
                          onPress={() =>
                            group.directSelect
                              ? choosePlace(group.root)
                              : setPickerProjectId(group.projectId)
                          }
                        />
                      );
                    })
                  )}
                </View>
              ) : null}
            </>
          ) : null}
          <View style={styles.line}>
            <Txt tone="muted" style={styles.key}>
              Profile
            </Txt>
            <View accessibilityRole="radiogroup" accessibilityLabel="Profile" style={styles.people}>
              {people.map((profile) => {
                const id = text(profile.id);
                const on = id === who;
                return (
                  <Pressable
                    key={id}
                    disabled={locked}
                    onPress={() => {
                      userPickedProfile.current = true;
                      setPickedProfileId(id);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on, disabled: locked }}
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
                    <Avatar id={id} size={24} />
                    <Txt tone={on ? "accent" : "text"}>{text(profile.name)}</Txt>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        {!chief && !employee && (!task || kind === "fake") ? (
          <Attachments value={attachments} onChange={setAttachments} disabled={busy} />
        ) : null}

        {!chief ? (
          <View style={styles.labelled}>
            <Txt v="meta" tone="secondary">
              {employee ? "Employee name" : task ? "Goal" : "Message"}
            </Txt>
            <TextInput
              editable={online && !busy}
              value={message}
              onChangeText={setMessage}
              maxLength={employee ? 150 : task ? 4000 : undefined}
              placeholder={
                employee
                  ? "Designer"
                  : task
                    ? "What should the agent do?"
                    : "What do you want to work on?"
              }
              placeholderTextColor={c["text-dim"]}
              multiline={!employee}
              accessibilityLabel={employee ? "Employee name" : task ? "Goal" : "Message"}
              style={employee ? field : [...field, styles.area]}
            />
          </View>
        ) : null}

        {task ? (
          showDoneWhen || Boolean(doneWhen) ? (
            <View style={styles.labelled}>
              <Txt v="meta" tone="secondary">
                Done when (optional)
              </Txt>
              <TextInput
                editable={online && !busy}
                value={doneWhen}
                onChangeText={setDoneWhen}
                maxLength={2000}
                placeholder="How you will judge the result"
                placeholderTextColor={c["text-dim"]}
                accessibilityLabel="Done when"
                style={field}
              />
            </View>
          ) : (
            <View style={styles.optionalRow}>
              <Button
                kind="plain"
                label="+ Done when"
                a11y="Add done when criteria"
                disabled={!online || busy}
                onPress={() => setShowDoneWhen(true)}
                style={styles.optionalButton}
              />
            </View>
          )
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
  group: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
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
  optionalRow: { alignItems: "flex-start", marginTop: -8 },
  optionalButton: { paddingHorizontal: 4 },
});
