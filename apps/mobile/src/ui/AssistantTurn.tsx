import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, StyleSheet, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { activityLabel, assistantSegments } from "../data/conversation";
import type { TranscriptRow } from "../data/timeline";
import { touch, useTheme } from "../theme";
import { Icon } from "./icons";
import { Txt } from "./kit";
import { Message } from "./Transcript";

/** The label stays readable while a decorative highlight signals progress. */
function Progress({ label }: { label: string }) {
  const { c } = useTheme();
  const highlight = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    let live = true;
    let animation: Animated.CompositeAnimation | undefined;
    const update = (reduced: boolean) => {
      animation?.stop();
      highlight.setValue(0);
      if (reduced || !live) return;
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(highlight, { toValue: 1, duration: 1000, useNativeDriver: true }),
          Animated.timing(highlight, { toValue: 0, duration: 1000, useNativeDriver: true }),
        ]),
        { iterations: 2 },
      );
      animation.start();
    };
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", update);
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(update)
      .catch(() => undefined);
    return () => {
      live = false;
      animation?.stop();
      subscription.remove();
    };
  }, [highlight]);
  return (
    <View
      style={styles.progress}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
    >
      <Animated.View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          StyleSheet.absoluteFill,
          {
            opacity: highlight.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 1, 0] }),
            transform: [
              {
                translateX: highlight.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-width, width],
                }),
              },
            ],
          },
        ]}
      >
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id="progress" x1="0%" x2="100%" y1="0%" y2="0%">
              <Stop offset="0" stopColor={c["text-secondary"]} stopOpacity={0} />
              <Stop offset="0.5" stopColor={c["text-secondary"]} stopOpacity={0.15} />
              <Stop offset="1" stopColor={c["text-secondary"]} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#progress)" />
        </Svg>
      </Animated.View>
      <Icon name="spark" size={14} color={c["text-secondary"]} />
      <Txt v="meta" tone="secondary" style={styles.progressLabel}>
        {label}
      </Txt>
    </View>
  );
}

function Activity({ rows, active }: { rows: TranscriptRow[]; active: boolean }) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const working = active && rows.some((row) => row.status === "running" || row.streaming);
  const label =
    working && rows.every((row) => row.kind === "thought")
      ? "Thinking…"
      : activityLabel(rows, active);
  return (
    <View>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        style={[styles.toggle, { backgroundColor: c["bg-sunken"] }]}
      >
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevron" size={12} color={c["text-secondary"]} />
        </View>
        {working ? (
          <Progress label={label} />
        ) : (
          <Txt v="meta" tone="secondary" style={styles.label}>
            {label}
          </Txt>
        )}
      </Pressable>
      {open ? (
        <View style={styles.details}>
          {rows.map((row) => (
            <Message key={row.id} row={row} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function AssistantTurn({
  rows,
  active,
  paused,
  threadId,
  onForward,
}: {
  rows: TranscriptRow[];
  active: boolean;
  paused: boolean;
  threadId: string;
  onForward?: (row: TranscriptRow) => void;
}) {
  const segments = assistantSegments(rows);
  const last = rows.at(-1);
  const tools = rows.some((row) => row.status === "running");
  return (
    <View style={styles.turn}>
      {segments.map((segment) =>
        segment.activity ? (
          <Activity
            key={segment.id}
            rows={segment.rows}
            active={active && !paused && segment === segments.at(-1)}
          />
        ) : (
          segment.rows.map((row) => (
            <Message
              key={row.id}
              row={row.streaming && row !== last ? { ...row, streaming: false } : row}
              threadId={threadId}
              onForward={onForward}
            />
          ))
        ),
      )}
      {active && !paused && !last?.streaming && last?.status !== "running" ? (
        <Progress
          label={tools ? "Using tools…" : last?.kind === "thought" ? "Thinking…" : "Working…"}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  turn: { gap: 12 },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: touch,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  label: { flex: 1, minWidth: 0 },
  progressLabel: { flexShrink: 1, minWidth: 0 },
  details: { gap: 8, paddingTop: 8 },
  progress: {
    alignSelf: "flex-start",
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 8,
    overflow: "hidden",
  },
});
