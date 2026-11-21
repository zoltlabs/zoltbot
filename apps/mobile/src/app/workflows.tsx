// R7: the workflows the Mac has published. Runs, pausing and approvals happen on the phone;
// building a workflow stays on the Mac.
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { latestWorkflows, workflowLine, workflowPaused, workflowRuns } from "../data/workflows";
import { useSnapshot } from "../state/link";
import { useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Group, Row, Txt } from "../ui/kit";

export default function Workflows() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { entities } = useSnapshot();
  const items = latestWorkflows(entities.workflow ?? []);
  const runs = workflowRuns(entities.workflowRun ?? []);
  const settings = entities.settings ?? [];
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar label="Routines" />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          Workflows
        </Txt>
        <OfflineBanner />
        {items.length ? (
          <Group>
            {items.map((workflow, index) => (
              <Row
                key={workflow.workflowId}
                title={workflow.name}
                detail={workflowLine(
                  workflowPaused(settings, workflow.workflowId),
                  runs.find((run) => run.workflowId === workflow.workflowId),
                )}
                onPress={() => router.push(`/workflow/${workflow.workflowId}`)}
                last={index === items.length - 1}
              />
            ))}
          </Group>
        ) : (
          <Txt tone="muted">No workflows yet. Build one on your Mac.</Txt>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
});
