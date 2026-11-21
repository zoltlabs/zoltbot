// R7: one workflow on the phone: run it, pause it, follow a run step by step and answer the
// approval waits that need you.
import { useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { AccessibilityInfo, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  awaitsApproval,
  kindLabel,
  latestWorkflows,
  reasonLabel,
  runLabel,
  runSteps,
  stepLabel,
  workflowError,
  workflowPaused,
  workflowRuns,
} from "../../data/workflows";
import { useAction } from "../../state/actions";
import { useClient, useSnapshot } from "../../state/link";
import { useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Button, Group, Row, Section, Txt } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";

const when = (at: string | undefined) =>
  at
    ? new Date(at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Starting";

export default function WorkflowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { entities } = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const [shownRun, setShownRun] = useState<string>();
  const [doing, setDoing] = useState<string>();
  const [error, setError] = useState("");
  // A second tap in the same frame sees stale state, so the guard is a ref.
  const acting = useRef(false);
  const workflow =
    latestWorkflows(entities.workflow ?? []).find((entry) => entry.workflowId === id) ?? null;
  const runs = workflowRuns(entities.workflowRun ?? [], id).slice(0, 10);

  // The key stays the same for one intent, so a timed-out command replays instead of repeating;
  // once the Mac answers, the next tap is a new command.
  const act = async (
    method: string,
    params: Record<string, unknown>,
    label: string,
    done: string,
  ) => {
    if (acting.current) return;
    acting.current = true;
    setError("");
    setDoing(label);
    try {
      await run(method, params, { key: `${method}:${JSON.stringify(params)}`, quiet: true });
      AccessibilityInfo.announceForAccessibility(done);
    } catch (cause) {
      const message = workflowError(cause);
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      acting.current = false;
      setDoing(undefined);
    }
  };

  if (workflow === null)
    return (
      <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
        <BackBar label="Workflows" />
        <Txt tone="muted" style={styles.body}>
          This workflow is gone.
        </Txt>
      </View>
    );

  const paused = workflowPaused(entities.settings ?? [], id);
  const current = runs.find((entry) => entry.id === shownRun) ?? runs[0];
  const steps = runSteps(workflow, current);
  const locked = !online || busy;
  const stop = (runId: string, stepId: string) =>
    Alert.alert("Stop this run?", "Steps after this one won't run.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Stop run",
        style: "destructive",
        onPress: () =>
          void act(
            "workflow.decide",
            { id: runId, stepId, decision: "stop" },
            "Stopping…",
            "Run stopped.",
          ),
      },
    ]);

  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar
        label="Workflows"
        right={
          paused ? undefined : (
            <Button
              kind="plain"
              label={doing === "Starting…" ? doing : "Run now"}
              disabled={locked}
              onPress={() =>
                void act("workflow.run", { id, inputs: {} }, "Starting…", "Run started.")
              }
            />
          )
        }
      />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          {workflow.name}
        </Txt>
        <OfflineBanner />
        {error ? <Txt tone="danger">{error}</Txt> : null}

        <Group>
          <Toggle
            label="On"
            value={!paused}
            disabled={locked}
            onChange={(on) =>
              void act(
                on ? "workflow.resume" : "workflow.pause",
                { id },
                on ? "Resuming…" : "Pausing…",
                on ? "Workflow on." : "Workflow paused.",
              )
            }
            last
          />
        </Group>

        <Section title="Steps" />
        {current ? (
          <Txt v="meta" tone="muted">
            {`${when(current.startedAt)} · ${runLabel[current.state]}`}
            {current.reason && reasonLabel[current.reason]
              ? ` · ${reasonLabel[current.reason]}`
              : ""}
          </Txt>
        ) : null}
        {steps.length ? (
          <Group>
            {steps.map(({ node, state }, index) => {
              const asks = current && awaitsApproval(node, state);
              return (
                <View key={node.id}>
                  <Row
                    title={node.name}
                    label={`${kindLabel[node.kind]}, ${node.name}, ${state ? stepLabel[state.state] : "Not run yet"}`}
                    detail={state ? stepLabel[state.state] : kindLabel[node.kind]}
                    last={index === steps.length - 1 && !asks}
                  />
                  {asks ? (
                    <View style={styles.decide}>
                      <Txt>Continue to the next steps, or stop this run?</Txt>
                      <View style={styles.buttons}>
                        <Button
                          label="Continue"
                          disabled={locked}
                          onPress={() =>
                            void act(
                              "workflow.decide",
                              { id: current.id, stepId: node.id, decision: "continue" },
                              "Continuing…",
                              "Run continues.",
                            )
                          }
                        />
                        <Button
                          label="Stop run"
                          kind="plain"
                          disabled={locked}
                          onPress={() => stop(current.id, node.id)}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </Group>
        ) : null}

        {runs.length > 1 ? (
          <>
            <Section title="Runs" />
            <Group>
              {runs.map((entry, index) => (
                <Row
                  key={entry.id}
                  title={when(entry.startedAt)}
                  detail={runLabel[entry.state]}
                  selected={entry.id === current?.id}
                  onPress={() => setShownRun(entry.id)}
                  last={index === runs.length - 1}
                />
              ))}
            </Group>
          </>
        ) : null}
        {runs.length ? null : <Txt tone="muted">No runs yet.</Txt>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
  decide: { paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  buttons: { flexDirection: "row", gap: 8 },
});
