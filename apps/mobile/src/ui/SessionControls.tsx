import { useRef, useState } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from "react-native";
import { singleFlight } from "../data/interactions";
import {
  backgroundTasks,
  effortLabel,
  type ModelState,
  type ModeState,
  modeError,
  modeState,
  runningBackground,
} from "../data/session";
import type { Row } from "../data/transport";
import { useAction } from "../state/actions";
import { useLink } from "../state/link";
import { touch, useTheme } from "../theme";
import { Icon } from "./icons";
import { Chip, Txt } from "./kit";

export function pick(
  title: string,
  message: string | undefined,
  labels: string[],
  choose: (index: number) => void,
) {
  if (Platform.OS === "ios") {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        ...(message ? { message } : {}),
        options: [...labels, "Cancel"],
        cancelButtonIndex: labels.length,
      },
      (index) => {
        if (index < labels.length) choose(index);
      },
    );
    return;
  }
  Alert.alert(title, message, [
    ...labels.map((label, index) => ({ text: label, onPress: () => choose(index) })),
    { text: "Cancel", style: "cancel" as const },
  ]);
}

/**
 * The session's permission mode. The phone offers only modes the adapter lists as safe (never
 * widening permission); the rest are changed on the Mac, which the sheet says in a footnote.
 */
export function ModeChip({ session, online }: { session: Row | undefined; online: boolean }) {
  const { c } = useTheme();
  const [busy, setBusy] = useState(false);
  const flight = useRef(singleFlight());
  const state: ModeState | undefined = modeState(session);
  if (!state || !session) return null;
  const apply = async (mode: string) => {
    const client = useLink.getState().client;
    if (!client || !flight.current.enter()) return;
    setBusy(true);
    try {
      await client.getState().call("session.setMode", { id: String(session.id), mode });
    } catch (error) {
      Alert.alert("Mode not changed", modeError(error));
    } finally {
      flight.current.leave();
      setBusy(false);
    }
  };
  const choose = (index: number) => {
    const option = state.options[index];
    if (option && option.mode !== state.current) void apply(option.mode);
  };
  const footnote = state.macOnly
    ? `${state.macOnly} ${state.macOnly === 1 ? "mode lets" : "modes let"} the agent act without asking. Change ${state.macOnly === 1 ? "it" : "those"} on your Mac.`
    : undefined;
  const disabled = !online || busy;
  return (
    <Pressable
      onPress={() =>
        pick(
          "Permission mode",
          footnote,
          state.options.map((option) =>
            option.mode === state.current ? `✓ ${option.label}` : option.label,
          ),
          choose,
        )
      }
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Permission mode: ${state.label}`}
      accessibilityHint="Changes how the agent asks before acting"
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={[
        styles.mode,
        { borderColor: c.border, backgroundColor: c["bg-raised"] },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Txt v="meta" tone="secondary">
        {busy ? "Switching…" : state.label}
      </Txt>
      <Icon name="down" size={12} color={c["text-muted"]} stroke={2} />
    </Pressable>
  );
}

const modelErrors: Record<string, string> = {
  unsupported_model: "This agent does not offer that model.",
  unsupported_effort: "That model does not take this effort level.",
  runtime_session_unavailable: "This chat is not running on your Mac. Send a message first.",
  runtime_unavailable: "Your Mac has no agents running right now.",
  model_change_failed: "The agent refused the change.",
};
/** Error text for a refused model or effort change. */
export function modelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return modelErrors[message.split(":")[0] ?? ""] ?? (message || "The model could not be changed.");
}

/**
 * The session's model and effort. Changing either after the first turn drops the provider's
 * cached history, so the phone says so before it asks the Mac.
 */
export function ModelChip({ state, online }: { state: ModelState | undefined; online: boolean }) {
  const { c } = useTheme();
  const { run, busy } = useAction();
  if (!state) return null;
  const apply = async (model: string, effort: string | undefined) => {
    try {
      await run(
        "session.setModel",
        {
          id: state.sessionId,
          model,
          ...(effort ? { effort } : {}),
          cacheWarningAccepted: true,
        },
        { quiet: true },
      );
    } catch (error) {
      Alert.alert("Model not changed", modelError(error));
    }
  };
  const confirm = (model: string, effort: string | undefined) => {
    if (model === state.current && effort === state.effort) return;
    if (!state.started) return void apply(model, effort);
    const name = state.models.find((row) => row.id === model)?.name ?? model;
    Alert.alert(
      `Switch to ${name}${effort ? ` · ${effortLabel(effort)}` : ""}?`,
      `The agent rereads this chat without its cache, so the next reply is slower and costs more.${state.running ? " The reply in progress keeps its model; the change starts with your next message." : ""}`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Switch", onPress: () => void apply(model, effort) },
      ],
    );
  };
  const chooseEffort = (model: string) => {
    if (!state.efforts.length) return confirm(model, undefined);
    const options = [undefined, ...state.efforts];
    pick(
      "Effort",
      "More effort thinks longer before answering.",
      options.map((effort) => {
        const label = effort ? effortLabel(effort) : "Default";
        return effort === state.effort && model === state.current ? `✓ ${label}` : label;
      }),
      (index) => confirm(model, options[index]),
    );
  };
  const disabled = !online || busy;
  const label = `${state.label}${state.effort ? ` · ${effortLabel(state.effort)}` : ""}`;
  return (
    <Pressable
      onPress={() =>
        pick(
          "Model",
          undefined,
          state.models.map((row) => (row.id === state.current ? `✓ ${row.name}` : row.name)),
          (index) => {
            const model = state.models[index];
            if (model) chooseEffort(model.id);
          },
        )
      }
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Model: ${label}`}
      accessibilityHint="Changes the model for the next replies"
      accessibilityState={{ disabled }}
      hitSlop={8}
      style={[
        styles.mode,
        { borderColor: c.border, backgroundColor: c["bg-raised"] },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Txt v="meta" tone="secondary" lines={1}>
        {busy ? "Switching…" : label}
      </Txt>
      <Icon name="down" size={12} color={c["text-muted"]} stroke={2} />
    </Pressable>
  );
}

/** "2 in background", tapping lists what is running. */
export function BackgroundChip({ session }: { session: Row | undefined }) {
  const running = runningBackground(session);
  if (!running.length) return null;
  const all = backgroundTasks(session);
  return (
    <Pressable
      onPress={() =>
        Alert.alert(
          "Background tasks",
          all
            .slice(-8)
            .map(
              (task) =>
                `${task.state === "running" ? "Running" : task.state}: ${task.description}${task.summary ? ` — ${task.summary}` : ""}`,
            )
            .join("\n"),
        )
      }
      accessibilityRole="button"
      accessibilityLabel={`${running.length} background ${running.length === 1 ? "task" : "tasks"} running`}
      hitSlop={6}
    >
      <Chip label={`${running.length} in background`} tone="neutral" dot />
    </Pressable>
  );
}

/** The latest to-do plan, pinned under the header: progress when folded, steps when open. */
export function PlanChecklist({
  plan,
}: {
  plan:
    | {
        entries: { step: string; status: string }[];
        done: number;
        total: number;
        current: string;
      }
    | undefined;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  if (!plan) return null;
  const progress = plan.total ? plan.done / plan.total : 0;
  return (
    <View style={[styles.plan, { borderBottomColor: c.border, backgroundColor: c["bg-raised"] }]}>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`Plan, ${plan.done} of ${plan.total} done${plan.current ? `, now ${plan.current}` : ""}`}
        style={styles.planHead}
      >
        <Txt v="meta" tone="secondary">{`Plan ${plan.done}/${plan.total}`}</Txt>
        <View style={[styles.track, { backgroundColor: c["bg-sunken"] }]}>
          <View
            style={[
              styles.fill,
              { backgroundColor: c.ok, width: `${Math.round(progress * 100)}%` },
            ]}
          />
        </View>
        <Txt v="meta" tone="muted" lines={1} style={styles.flex}>
          {plan.current}
        </Txt>
        <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
          <Icon name="down" size={14} color={c["text-muted"]} stroke={2} />
        </View>
      </Pressable>
      {open ? (
        <View style={styles.steps}>
          {plan.entries.map((entry, index) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: steps can repeat; order is identity
              key={index}
              style={styles.step}
              accessible
              accessibilityLabel={`${entry.step}, ${entry.status.replace("_", " ")}`}
            >
              <Txt
                tone={
                  entry.status === "completed"
                    ? "ok"
                    : entry.status === "in_progress"
                      ? "accent"
                      : "muted"
                }
              >
                {entry.status === "completed" ? "☑" : entry.status === "in_progress" ? "◐" : "☐"}
              </Txt>
              <Txt
                tone={entry.status === "completed" ? "muted" : "text"}
                style={[
                  styles.flex,
                  entry.status === "completed" && styles.struck,
                  entry.status === "in_progress" && styles.strong,
                ]}
              >
                {entry.step}
              </Txt>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  mode: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    minHeight: touch,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  plan: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16 },
  planHead: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: touch },
  track: { width: 56, height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  steps: { gap: 6, paddingBottom: 12 },
  step: { flexDirection: "row", gap: 8 },
  struck: { textDecorationLine: "line-through" },
  strong: { fontWeight: "600" },
});
