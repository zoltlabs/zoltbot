// C6: swipe a message to the right to reply to it. The Reply option in Message actions does the
// same for VoiceOver and Switch Control.
import { type ReactNode, useRef, useState } from "react";
import { AccessibilityInfo, Animated, PanResponder } from "react-native";

const TRIGGER = 56;
const LIMIT = 72;

export function SwipeReply({ onReply, children }: { onReply?: () => void; children: ReactNode }) {
  const [shift] = useState(() => new Animated.Value(0));
  const reply = useRef(onReply);
  reply.current = onReply;
  const [pan] = useState(() =>
    PanResponder.create({
      // Claim only clear rightward drags so vertical scrolling keeps working.
      onMoveShouldSetPanResponder: (_, g) =>
        !!reply.current && g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderMove: (_, g) => shift.setValue(Math.max(0, Math.min(LIMIT, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (g.dx >= TRIGGER) reply.current?.();
        void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
          if (reduced) shift.setValue(0);
          else Animated.spring(shift, { toValue: 0, useNativeDriver: true }).start();
        });
      },
      onPanResponderTerminate: () => shift.setValue(0),
    }),
  );
  if (!onReply) return <>{children}</>;
  return (
    <Animated.View style={{ transform: [{ translateX: shift }] }} {...pan.panHandlers}>
      {children}
    </Animated.View>
  );
}
