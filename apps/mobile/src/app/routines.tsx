import { Value } from "@sinclair/typebox/value";
import { type Routine, RoutineSchema } from "@zoltbot/protocol";
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { routineStatus, scheduleLabel } from "../data/manage";
import { useSnapshot } from "../state/link";
import { useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Chip, Group, Row, Txt } from "../ui/kit";

export default function Routines() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const routines = (useSnapshot().entities.routine ?? [])
    .filter((row): row is Routine => Value.Check(RoutineSchema, row))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar label="Tasks" />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          Routines
        </Txt>
        <OfflineBanner />
        {routines.length ? (
          <Group>
            {routines.map((routine, index) => (
              <Row
                key={routine.id}
                title={routine.name}
                meta={`${routine.event ? "On GitHub events" : scheduleLabel(routine.schedule.cron)} · ${routineStatus(routine)}`}
                right={routine.paused ? <Chip label="Paused" /> : undefined}
                onPress={() => router.push(`/routine/${routine.id}`)}
                last={index === routines.length - 1}
              />
            ))}
          </Group>
        ) : (
          <Txt tone="muted">No routines yet. Make one from a finished task on your Mac.</Txt>
        )}
        <Txt v="meta" tone="muted">
          Runs need your Mac awake.
        </Txt>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
});
