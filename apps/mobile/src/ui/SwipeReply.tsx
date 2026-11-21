// C6: swipe a message to the right to reply to it. P5: drag it left to see when it was written.
// The message menu offers Reply, and VoiceOver's Show time, for anyone who can't drag.
import * as Haptics from "expo-haptics";
import { type ReactNode, useRef, useState } from "react";
import { AccessibilityInfo, Animated, PanResponder, StyleSheet, View } from "react-native";
import { Txt } from "./kit";

const TRIGGER = 56;
const LIMIT = 72;
/** Room for a dated time ("Oct 2, 3:42 PM"); longer ones wrap to a second line. */
const REVEAL = 104;

export function SwipeReply({
  onReply,
  time,
  children,
}: {
  onReply?: (() => void) | undefined;
  /** Shown at the right edge while the message is dragged left. */
  time?: string | undefined;
  children: ReactNode;
}) {
  const [shift] = useState(() => new Animated.Value(0));
  const latest = useRef({ onReply, time });
  latest.current = { onReply, time };
  const crossed = useRef(false);
  const [pan] = useState(() =>
    PanResponder.create({
      // Claim only clear sideways drags so vertical scrolling keeps working.
      onMoveShouldSetPanResponder: (_, g) => {
        if (Math.abs(g.dx) <= 12 || Math.abs(g.dx) <= Math.abs(g.dy) * 2) return false;
        return g.dx > 0 ? !!latest.current.onReply : !!latest.current.time;
      },
      onPanResponderGrant: () => {
        crossed.current = false;
      },
      onPanResponderMove: (_, g) => {
        const right = latest.current.onReply ? LIMIT : 0;
        const left = latest.current.time ? -REVEAL : 0;
        shift.setValue(Math.max(left, Math.min(right, g.dx)));
        const past = g.dx >= TRIGGER && !!latest.current.onReply;
        if (past && !crossed.current)
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        crossed.current = past;
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx >= TRIGGER) latest.current.onReply?.();
        void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
          if (reduced) shift.setValue(0);
          else Animated.spring(shift, { toValue: 0, useNativeDriver: true }).start();
        });
      },
      onPanResponderTerminate: () => shift.setValue(0),
    }),
  );
  if (!onReply && !time) return <>{children}</>;
  return (
    <View>
      {time ? (
        <Animated.View
          pointerEvents="none"
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          style={[
            styles.time,
            {
              opacity: shift.interpolate({ inputRange: [-REVEAL, -16, 0], outputRange: [1, 0, 0] }),
            },
          ]}
        >
          <Txt v="meta" tone="muted" lines={2} style={{ textAlign: "right" }}>
            {time}
          </Txt>
        </Animated.View>
      ) : null}
      <Animated.View style={{ transform: [{ translateX: shift }] }} {...pan.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  time: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: REVEAL - 8,
    justifyContent: "center",
    alignItems: "flex-end",
  },
});
