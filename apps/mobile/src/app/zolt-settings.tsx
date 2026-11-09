import { chiefName, chiefQueueKeys, chiefWakeSummary } from "@zoltbot/ui/chief/data";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { isConflict, writeError } from "../data/manage";
import { clock, readClock } from "../data/preferences";
import type { Row as Entity } from "../data/transport";
import { useAction } from "../state/actions";
import { useClient, useLink, useSnapshot } from "../state/link";
import { touch, type as typography, useTheme } from "../theme";
import { OfflineBanner } from "../ui/chrome";
import { Button, Group, Row, Section, Txt } from "../ui/kit";
import { Toggle } from "../ui/Toggle";

// Zolt's brief, wake-ups and quiet hours. These are the Mac's shared settings (D-3), the same
// rows the desktop's Zolt page and Notifications settings write; this phone's own pushes live in
// Settings.

function TimeField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { c } = useTheme();
  const [draft, setDraft] = useState(value);
  const commit = () => {
    const time = readClock(draft);
    if (time && time !== value) onChange(time);
    setDraft(time ?? value);
  };
  return (
    <View style={styles.time}>
      <Txt tone="secondary" style={styles.flex}>
        {label}
      </Txt>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        editable={!disabled}
        keyboardType="numbers-and-punctuation"
        returnKeyType="done"
        maxLength={5}
        accessibilityLabel={label}
        style={[
          typography.bodyMedium,
          styles.timeInput,
          { color: c.text, borderColor: c["border-strong"], backgroundColor: c["bg-page"] },
        ]}
      />
    </View>
  );
}

export default function ZoltSettings() {
  const snapshot = useSnapshot();
  const { c } = useTheme();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const name = chiefName(snapshot.entities);
  const wake = chiefWakeSummary(snapshot.entities, Date.now());
  const setting = (key: string) =>
    (snapshot.entities.settings?.find((row) => row.key === key)?.value ?? {}) as Entity;
  const notifications = setting("notifications");
  const quiet = (notifications.quietHours ?? {}) as Entity;
  const quietStart = clock.test(String(quiet.start)) ? String(quiet.start) : "22:00";
  const quietEnd = clock.test(String(quiet.end)) ? String(quiet.end) : "07:00";
  const locked = !online || busy;
  // Each write merges into the row's current value, as the desktop does, and names that value so
  // a change saved on the Mac in the meantime is never overwritten without asking.
  const merge = async (key: string, changes: Entity): Promise<void> => {
    const row = useLink
      .getState()
      .client?.getState()
      .snapshot.entities.settings?.find((entry) => entry.key === key);
    const value = { ...((row?.value ?? {}) as Entity), ...changes };
    try {
      await run(
        "settings.set",
        { key, value, expected: row ? { value: row.value } : {} },
        { quiet: true },
      );
    } catch (cause) {
      if (!isConflict(cause)) return Alert.alert("Not saved", writeError(cause));
      Alert.alert("Changed on your Mac", undefined, [
        { text: "Keep Mac's", style: "cancel" },
        { text: "Save mine", onPress: () => void merge(key, changes) },
      ]);
    }
  };
  const proactive = (changes: Entity) => merge(chiefQueueKeys.proactive, changes);
  const brief = (changes: Entity) => proactive({ brief: { ...wake.brief, ...changes } });
  const quietHours = (changes: Entity) =>
    merge("notifications", {
      quietHours: {
        enabled: quiet.enabled === true,
        start: quietStart,
        end: quietEnd,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...changes,
      },
    });
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c["bg-page"] }}
      contentContainerStyle={styles.page}
    >
      <View style={styles.head}>
        <Txt v="cardTitle" accessibilityRole="header">
          {name}
        </Txt>
        <Button kind="plain" label="Done" onPress={() => router.back()} />
      </View>
      <OfflineBanner />

      <Section title="Morning brief" />
      <Group>
        <Toggle
          label="Send a brief"
          value={wake.brief.enabled}
          disabled={locked}
          onChange={(enabled) => brief({ enabled })}
          last={!wake.brief.enabled}
        />
        {wake.brief.enabled ? (
          <TimeField
            key={wake.brief.time}
            label="At"
            value={wake.brief.time}
            disabled={locked}
            onChange={(time) => brief({ time })}
          />
        ) : null}
      </Group>

      <Section title="Wake-ups" />
      <Group>
        <Toggle
          label="Check in on its own"
          note={`${wake.used} of ${wake.allowance} used today`}
          value={wake.enabled}
          disabled={locked}
          onChange={(enabled) => proactive({ enabled })}
          last
        />
      </Group>

      <Section title="Notifications" />
      <Group>
        <Toggle
          label="Notify me"
          value={notifications.enabled !== false}
          disabled={locked}
          onChange={(enabled) => merge("notifications", { enabled })}
        />
        <Toggle
          label="Quiet hours"
          value={quiet.enabled === true}
          disabled={locked}
          onChange={(enabled) => quietHours({ enabled })}
          last={quiet.enabled !== true}
        />
        {quiet.enabled === true ? (
          <>
            <TimeField
              key={`start-${quietStart}`}
              label="From"
              value={quietStart}
              disabled={locked}
              onChange={(start) => quietHours({ start })}
            />
            <TimeField
              key={`end-${quietEnd}`}
              label="Until"
              value={quietEnd}
              disabled={locked}
              onChange={(end) => quietHours({ end })}
            />
          </>
        ) : null}
        <Row
          title="This phone"
          meta="Needs you and results"
          onPress={() => router.navigate("/settings")}
          last
        />
      </Group>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 12 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  flex: { flex: 1 },
  time: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: touch,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  timeInput: {
    width: 76,
    minHeight: 36,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    textAlign: "center",
  },
});
