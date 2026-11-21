// P6: Settings › Appearance › Text size. A notched slider and a line drawn at the chosen size.
import { useRef, useState } from "react";
import { type LayoutChangeEvent, PanResponder, Pressable, StyleSheet, View } from "react-native";
import { nearestTextSize, textSizeLabel, textSizes } from "../data/text-size";
import { useTextSize } from "../state/text-size";
import { touch, useTheme } from "../theme";
import { Txt } from "./kit";

const THUMB = 28;

export function TextSizeSettings() {
  const { c } = useTheme();
  const { size, set } = useTextSize();
  const [width, setWidth] = useState(0);
  const index = textSizes.indexOf(size);
  const at = (x: number) =>
    set(nearestTextSize(width > THUMB ? (x - THUMB / 2) / (width - THUMB) : 0));
  const latest = useRef(at);
  latest.current = at;
  const [pan] = useState(() =>
    PanResponder.create({
      // Sideways drags only, so a scroll that starts here still scrolls. A tap is the Pressable's.
      onMoveShouldSetPanResponderCapture: (_, g) =>
        Math.abs(g.dx) > 4 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (event) => latest.current(event.nativeEvent.locationX),
    }),
  );
  const step = (by: number) => {
    const next = textSizes[index + by];
    if (next) set(next);
  };
  const left = width > THUMB ? (index / (textSizes.length - 1)) * (width - THUMB) : 0;
  return (
    <View style={styles.root}>
      {/* The slider below says its name and value to VoiceOver. */}
      <View
        style={styles.head}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Txt>Text size</Txt>
        <Txt tone="secondary">{textSizeLabel(size)}</Txt>
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Text size"
        accessibilityValue={{ text: textSizeLabel(size) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(event) =>
          step(event.nativeEvent.actionName === "increment" ? 1 : -1)
        }
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        style={styles.track}
        {...pan.panHandlers}
      >
        <Pressable
          accessible={false}
          style={StyleSheet.absoluteFill}
          onPress={(event) => at(event.nativeEvent.locationX)}
        />
        <View pointerEvents="none" style={[styles.line, { backgroundColor: c["border-strong"] }]} />
        {textSizes.map((notch, i) => (
          <View
            key={notch}
            pointerEvents="none"
            style={[
              styles.notch,
              {
                left:
                  width > THUMB
                    ? (i / (textSizes.length - 1)) * (width - THUMB) + THUMB / 2 - 1
                    : 0,
                backgroundColor: c["border-strong"],
              },
            ]}
          />
        ))}
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            { left, backgroundColor: c["bg-raised"], borderColor: c["border-strong"] },
          ]}
        />
      </View>
      <Txt>Your agent finished the report. Want me to send it?</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8, paddingVertical: 8 },
  head: { flexDirection: "row", justifyContent: "space-between" },
  track: { height: touch, justifyContent: "center" },
  line: { position: "absolute", left: THUMB / 2, right: THUMB / 2, height: 2, borderRadius: 1 },
  notch: { position: "absolute", width: 2, height: 10, borderRadius: 1 },
  thumb: {
    position: "absolute",
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
});
