import { Value } from "@sinclair/typebox/value";
import {
  type Routine,
  type RoutineOccurrence,
  RoutineOccurrenceSchema,
  RoutineSchema,
} from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  clockText,
  isConflict,
  notifyLabel,
  outcomeLabel,
  readClockText,
  readSchedule,
  routineStatus,
  runLabel,
  type Schedule,
  scheduleLabel,
  writeError,
  writeSchedule,
} from "../../data/manage";
import { text } from "../../data/view";
import { useAction } from "../../state/actions";
import { useClient, useLink, useSnapshot } from "../../state/link";
import { mono, touch, type as typography, useTheme } from "../../theme";
import { Conflict } from "../../ui/Conflict";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Button, Group, Row, Section, Segmented, Txt } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";

type Days = "daily" | "weekdays" | "custom";
interface Draft {
  time: string;
  days: Days;
  minutes: string;
  timezone: string;
  notify: Routine["notify"];
}
/** What the phone asks routine.update to change, kept whole so a conflict can resend it. */
type Changes = Partial<Pick<Routine, "schedule" | "notify" | "paused">>;

function draftOf(routine: Routine): Draft {
  const schedule = readSchedule(routine.schedule.cron);
  return {
    time: schedule.kind === "time" ? clockText(schedule.hour, schedule.minute) : "9:00",
    days:
      schedule.kind !== "time"
        ? "daily"
        : typeof schedule.days === "string"
          ? schedule.days
          : "custom",
    minutes: schedule.kind === "interval" ? String(schedule.minutes) : "60",
    timezone: routine.schedule.timezone,
    notify: routine.notify,
  };
}
/** The cron a draft asks for, or undefined while the typed time or interval is not valid. */
function cronOf(draft: Draft, current: Schedule): string | undefined {
  if (current.kind === "other") return current.cron;
  if (current.kind === "interval") {
    const minutes = Number(draft.minutes);
    return Number.isInteger(minutes) && minutes > 0 && minutes < 1_000_000
      ? writeSchedule({ kind: "interval", minutes })
      : undefined;
  }
  const clock = readClockText(draft.time);
  if (!clock) return undefined;
  const days = draft.days === "custom" ? current.days : draft.days;
  return writeSchedule({ kind: "time", ...clock, days });
}
const summary = (value: { cron: string; timezone: string; notify: string; paused: boolean }) =>
  [
    value.paused ? "Paused" : "On",
    `${scheduleLabel(value.cron)} (${value.timezone})`,
    notifyLabel(value.notify as Routine["notify"]),
  ].join(" · ");

export default function RoutineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const row = snapshot.entities.routine?.find((entry) => entry.id === id);
  const routine = Value.Check(RoutineSchema, row) ? row : undefined;
  const [draft, setDraft] = useState<Draft>();
  const [conflict, setConflict] = useState<Changes>();
  const [error, setError] = useState("");
  const [history, setHistory] = useState<RoutineOccurrence[]>();

  // Fetched again whenever the routine changes.
  const updatedAt = routine?.updatedAt;
  useEffect(() => {
    const client = useLink.getState().client?.getState();
    if (!client || !online || !updatedAt) return;
    let live = true;
    client
      .call("routine.history", { id })
      .then((value) => {
        const items = ((value ?? {}) as { items?: unknown[] }).items ?? [];
        if (live)
          setHistory(
            items.filter((item): item is RoutineOccurrence =>
              Value.Check(RoutineOccurrenceSchema, item),
            ),
          );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id, online, updatedAt]);

  if (!routine)
    return (
      <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
        <BackBar label="Routines" />
        <Txt tone="muted" style={styles.body}>
          This routine is gone.
        </Txt>
      </View>
    );

  const schedule = readSchedule(routine.schedule.cron);
  const shown = draft ?? draftOf(routine);
  const edit = (patch: Partial<Draft>) => setDraft({ ...shown, ...patch });
  const cron = cronOf(shown, schedule);
  const scheduleChanged =
    !!cron && (cron !== routine.schedule.cron || shown.timezone !== routine.schedule.timezone);
  const changes: Changes = {
    ...(scheduleChanged && cron ? { schedule: { cron, timezone: shown.timezone.trim() } } : {}),
    ...(shown.notify !== routine.notify ? { notify: shown.notify } : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  const save = async (next: Changes, expectedUpdatedAt: string) => {
    setError("");
    try {
      await run("routine.update", { id, expectedUpdatedAt, ...next }, { quiet: true });
      setDraft(undefined);
      setConflict(undefined);
    } catch (cause) {
      if (isConflict(cause)) setConflict(next);
      else setError(writeError(cause));
    }
  };
  const pause = async (paused: boolean) => {
    if (!routine.event) return save({ paused }, routine.updatedAt);
    setError("");
    await run("routine.pause", { id, revision: routine.event.revision }, { quiet: true }).catch(
      (cause: unknown) => setError(writeError(cause)),
    );
  };

  const runs = [...(history ?? [])]
    .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
    .slice(0, 20);
  const tasks = snapshot.entities.task ?? [];
  const locked = !online || busy || !!conflict;
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar
        label="Routines"
        right={
          dirty ? (
            <Button
              kind="plain"
              label={busy ? "Saving…" : "Save"}
              disabled={locked || !shown.timezone.trim()}
              onPress={() => void save(changes, routine.updatedAt)}
            />
          ) : undefined
        }
      />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          {routine.name}
        </Txt>
        <Txt v="meta" tone="muted">
          {routineStatus(routine)}
        </Txt>
        <OfflineBanner />
        {conflict ? (
          <Conflict
            mac={summary({ ...routine.schedule, notify: routine.notify, paused: routine.paused })}
            mine={summary({
              ...(conflict.schedule ?? routine.schedule),
              notify: conflict.notify ?? routine.notify,
              paused: conflict.paused ?? routine.paused,
            })}
            busy={busy || !online}
            onKeep={() => {
              setConflict(undefined);
              setDraft(undefined);
            }}
            onSave={() => void save(conflict, routine.updatedAt)}
          />
        ) : null}
        {error ? <Txt tone="danger">{error}</Txt> : null}

        <Group>
          <Toggle
            label="On"
            value={!routine.paused}
            disabled={locked || (!!routine.event && routine.paused)}
            onChange={(on) => void pause(!on)}
            last
          />
        </Group>
        {routine.event && routine.paused ? (
          <Txt v="meta" tone="muted">
            Turn back on from the chat on your Mac.
          </Txt>
        ) : null}

        {routine.event ? null : (
          <>
            <Section title="Schedule" />
            {schedule.kind === "other" ? (
              <Txt v="meta" style={{ fontFamily: mono }}>
                {schedule.cron}
              </Txt>
            ) : schedule.kind === "interval" ? (
              <View style={styles.inline}>
                <Txt>Every</Txt>
                <TextInput
                  value={shown.minutes}
                  onChangeText={(minutes) => edit({ minutes })}
                  keyboardType="number-pad"
                  editable={!locked}
                  accessibilityLabel="Minutes between runs"
                  style={[styles.input, styles.short, field(c)]}
                />
                <Txt>min</Txt>
              </View>
            ) : (
              <>
                <Segmented<Days>
                  label="Days"
                  value={shown.days}
                  onChange={(days) => edit({ days })}
                  disabled={locked}
                  options={[
                    { value: "daily", label: "Every day" },
                    { value: "weekdays", label: "Weekdays" },
                    ...(Array.isArray(schedule.days)
                      ? [
                          {
                            value: "custom" as const,
                            label:
                              scheduleLabel(routine.schedule.cron).split(" at ")[0] ?? "Custom",
                          },
                        ]
                      : []),
                  ]}
                />
                <View style={styles.inline}>
                  <Txt>At</Txt>
                  <TextInput
                    value={shown.time}
                    onChangeText={(time) => edit({ time })}
                    keyboardType="numbers-and-punctuation"
                    editable={!locked}
                    placeholder="9:00"
                    accessibilityLabel="Time"
                    style={[styles.input, styles.short, field(c)]}
                  />
                </View>
                {cron ? null : (
                  <Txt v="meta" tone="danger">
                    Use a time like 9:00.
                  </Txt>
                )}
              </>
            )}
            <TextInput
              value={shown.timezone}
              onChangeText={(timezone) => edit({ timezone })}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!locked && schedule.kind !== "other"}
              accessibilityLabel="Timezone"
              style={[styles.input, field(c)]}
            />
          </>
        )}

        <Section title="Notify" />
        <Segmented<Routine["notify"]>
          label="Notify"
          value={shown.notify}
          onChange={(notify) => edit({ notify })}
          disabled={locked || !!routine.event}
          options={[
            { value: "always", label: notifyLabel("always") },
            { value: "actionable_only", label: notifyLabel("actionable_only") },
          ]}
        />

        <Section title="Runs" />
        {runs.length ? (
          <Group>
            {runs.map((occurrence, index) => {
              const threadId = text(tasks.find((task) => task.id === occurrence.taskId)?.threadId);
              return (
                <Row
                  key={occurrence.id}
                  title={new Date(occurrence.scheduledAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  meta={[
                    runLabel[occurrence.status] ?? occurrence.status,
                    occurrence.outcome ? outcomeLabel[occurrence.outcome] : "",
                    occurrence.reason ?? "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onPress={threadId ? () => router.push(`/chat/${threadId}`) : undefined}
                  last={index === runs.length - 1}
                />
              );
            })}
          </Group>
        ) : (
          <Txt tone="muted">{history ? "No runs yet." : "Loading…"}</Txt>
        )}
      </ScrollView>
    </View>
  );
}

const field = (c: ReturnType<typeof useTheme>["c"]) => ({
  color: c.text,
  borderColor: c["border-strong"],
  backgroundColor: c["bg-raised"],
});

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
  inline: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    ...typography.body,
    minHeight: touch,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
  },
  short: { minWidth: 88 },
});
