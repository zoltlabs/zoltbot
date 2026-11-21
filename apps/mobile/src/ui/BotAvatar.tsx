import { assignHues, avatarHue, botSilhouette } from "@zoltbot/ui/bot-avatar-shapes";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import { AccessibilityInfo, Animated, StyleSheet } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import { useClient } from "../state/link";
import { avatarColors, useTheme } from "../theme";

const BotHues = createContext<ReadonlyMap<string, number>>(new Map());

/** The colour a chat's avatar wears, for marks that belong to that agent. */
export function useBotColor(id: string, zolt = false): string {
  const { c } = useTheme();
  const hues = useContext(BotHues);
  return avatarColors(c, zolt ? 4 : (hues.get(id) ?? avatarHue(id))).body;
}

export function BotAvatarPalette({ children }: { children: ReactNode }) {
  const threads = useClient((state) => state.snapshot.entities.thread);
  const hues = useMemo(
    () =>
      assignHues(
        (threads ?? []).map((thread) => ({
          id: String(thread.id),
          createdAt: typeof thread.createdAt === "string" ? thread.createdAt : undefined,
        })),
      ),
    [threads],
  );
  return <BotHues.Provider value={hues}>{children}</BotHues.Provider>;
}

export function BotAvatar({
  id,
  size = 32,
  zolt = false,
  working = false,
}: {
  id: string;
  size?: number;
  zolt?: boolean;
  working?: boolean;
}) {
  const { c } = useTheme();
  const hues = useContext(BotHues);
  const hue = zolt ? 4 : (hues.get(id) ?? avatarHue(id));
  const colors = avatarColors(c, hue);
  const motion = useRef(new Animated.Value(0)).current;
  const lift = motion.interpolate({ inputRange: [0, 1], outputRange: [0, -2] });
  useEffect(() => {
    let current = true;
    let changed = false;
    let animation: Animated.CompositeAnimation | undefined;
    const update = (reduced: boolean) => {
      if (!current) return;
      animation?.stop();
      motion.setValue(0);
      if (reduced) return;
      animation = Animated.sequence([
        Animated.delay(working ? 0 : 450 + hue * 90),
        Animated.loop(
          Animated.sequence([
            Animated.timing(motion, {
              toValue: 1,
              duration: working ? 260 : 85,
              useNativeDriver: true,
              isInteraction: false,
            }),
            Animated.timing(motion, {
              toValue: 0,
              duration: working ? 340 : 105,
              useNativeDriver: true,
              isInteraction: false,
            }),
          ]),
          { iterations: working ? 3 : 1 },
        ),
      ]);
      animation.start();
    };
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (reduced) => {
      changed = true;
      update(reduced);
    });
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((reduced) => {
        if (!changed) update(reduced);
      })
      .catch(() => undefined);
    return () => {
      current = false;
      animation?.stop();
      subscription.remove();
    };
  }, [hue, motion, working]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{
        width: size,
        height: size,
        transform: [{ translateY: working ? lift : 0 }],
      }}
    >
      <Svg width={size} height={size} viewBox="0 0 32 32">
        <Path d={botSilhouette(hue, zolt) ?? ""} fill={colors.eye} />
        <Path
          d="M13 21q3 4 6 0"
          stroke={colors.screen}
          strokeWidth={1.5}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [
              {
                scaleY: motion.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, working ? 0.75 : 0.12],
                }),
              },
            ],
          },
        ]}
      >
        <Svg width={size} height={size} viewBox="0 0 32 32">
          <Rect x={10} y={14} width={3} height={4} rx={1} fill={colors.screen} />
          <Rect x={19} y={14} width={3} height={4} rx={1} fill={colors.screen} />
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}
