// P8: the agent's own browser, live from the Mac. "Take over" gives the owner the mouse while the
// agent waits; "Hand back" returns it. Frames are never stored.
import { useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import {
  AccessibilityInfo,
  Image,
  type LayoutChangeEvent,
  PanResponder,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type Box,
  click,
  fit,
  movePointer,
  type Point,
  press,
  screenError,
  scroll,
  shortUrl,
  toPage,
  typeText,
} from "../../data/browser-screen";
import { profileName } from "../../data/view";
import { useBrowserScreen } from "../../state/browser-screen";
import { useSnapshot } from "../../state/link";
import { sans, touch, useTheme } from "../../theme";
import { BackBar, OfflineBanner } from "../../ui/chrome";
import { Button, Segmented, Txt } from "../../ui/kit";

type Mode = "touch" | "trackpad";
/** A finger that moves less than this is a tap. */
const TAP_SLOP = 8;
/** Scrolls and pointer moves go out at most this often while a finger drags. */
const DRAG_MS = 80;

export default function BrowserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const thread = (snapshot.entities.thread ?? []).find((row) => row.id === id);
  const who = profileName(snapshot, thread?.agentId);
  const { online, frame, state, takeover, send } = useBrowserScreen(id);
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });
  const [mode, setMode] = useState<Mode>("touch");
  const [pointer, setPointer] = useState<Point>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const control = !!state?.control;

  // The gesture reads the latest values without being rebuilt.
  /** A click on the page; whatever field it lands in starts empty for the phone's keyboard. */
  const clickAt = (point: Point) => send(click(point));
  const latest = useRef({ box, frame, mode, pointer, control, send, click: clickAt });
  latest.current = { box, frame, mode, pointer, control, send, click: clickAt };
  const drag = useRef({ start: { x: 0, y: 0 }, sent: { x: 0, y: 0 }, at: 0, moved: false });
  /** Sends the part of a drag not sent yet: a scroll, or a trackpad pointer move. */
  const dragBy = (dx: number, dy: number) => {
    const { box: area, frame: shown, mode: how, pointer: at } = latest.current;
    if (!shown) return;
    const step = { x: dx - drag.current.sent.x, y: dy - drag.current.sent.y };
    if (!step.x && !step.y) return;
    drag.current.sent = { x: dx, y: dy };
    const { scale } = fit(area, shown);
    if (how === "trackpad") {
      const next = movePointer(at ?? centre(shown), step, scale, shown);
      latest.current.pointer = next;
      setPointer(next);
      latest.current.send([{ kind: "mouse", type: "move", ...next }]);
    } else {
      const point = toPage(drag.current.start, area, shown);
      if (point) latest.current.send([scroll(point, step, scale)]);
    }
  };
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => latest.current.control && !!latest.current.frame,
      onMoveShouldSetPanResponder: () => latest.current.control && !!latest.current.frame,
      onPanResponderGrant: (event) => {
        const { locationX: x, locationY: y } = event.nativeEvent;
        drag.current = { start: { x, y }, sent: { x: 0, y: 0 }, at: 0, moved: false };
      },
      onPanResponderMove: (_, g) => {
        if (Math.hypot(g.dx, g.dy) > TAP_SLOP) drag.current.moved = true;
        const now = Date.now();
        if (!drag.current.moved || now - drag.current.at < DRAG_MS) return;
        drag.current.at = now;
        dragBy(g.dx, g.dy);
      },
      onPanResponderRelease: (_, g) => {
        const { box: area, frame: shown, mode: how, pointer: at } = latest.current;
        if (!shown) return;
        // The end of a drag after the last throttled step still counts.
        if (drag.current.moved) return dragBy(g.dx, g.dy);
        const point =
          how === "trackpad" ? (at ?? centre(shown)) : toPage(drag.current.start, area, shown);
        if (point) latest.current.click(point);
      },
      onPanResponderTerminate: (_, g) => {
        if (drag.current.moved) dragBy(g.dx, g.dy);
      },
    }),
  );

  const toggle = async () => {
    setBusy(true);
    setError("");
    try {
      await takeover(!control);
      setPointer(undefined);
    } catch (failure) {
      const message = screenError(failure, !control);
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setBusy(false);
    }
  };

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox({ width, height });
  };
  const at = frame ? fit(box, frame) : undefined;
  const url = frame?.url || state?.url || "";
  const empty = !state?.running && !frame;

  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <BackBar label="the chat" iconOnly />
        <View style={styles.title}>
          <Txt v="cardTitle" lines={1} accessibilityRole="header">
            {`${who}’s browser`}
          </Txt>
          {url ? (
            <Txt v="meta" tone="muted" lines={1}>
              {shortUrl(url)}
            </Txt>
          ) : null}
        </View>
      </View>
      <OfflineBanner />
      <View
        style={[styles.screen, { backgroundColor: c["bg-sunken"] }]}
        onLayout={onLayout}
        accessible={!!frame}
        accessibilityRole="image"
        accessibilityLabel={url ? `${who}’s browser showing ${shortUrl(url)}` : `${who}’s browser`}
        accessibilityHint={control ? "Use the actions to click or scroll the page." : undefined}
        accessibilityActions={control ? screenActions : undefined}
        onAccessibilityAction={(event) => {
          if (!frame) return;
          const point = mode === "trackpad" && pointer ? pointer : centre(frame);
          const name = event.nativeEvent.actionName;
          if (name === "activate" || name === "click") clickAt(point);
          else if (name === "scrollUp" || name === "scrollDown")
            send([
              {
                kind: "mouse",
                type: "wheel",
                ...point,
                deltaX: 0,
                deltaY: (name === "scrollUp" ? -0.8 : 0.8) * frame.height,
              },
            ]);
        }}
        {...pan.panHandlers}
      >
        {frame && at ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${frame.data}` }}
            style={{
              position: "absolute",
              left: at.left,
              top: at.top,
              width: at.width,
              height: at.height,
            }}
            fadeDuration={0}
            resizeMode="stretch"
            pointerEvents="none"
          />
        ) : (
          <View style={styles.empty} pointerEvents="none">
            <Txt v="body" tone="muted" style={styles.centred}>
              {empty ? `${who} hasn’t opened a page yet.` : online ? "Loading…" : ""}
            </Txt>
          </View>
        )}
        {control && mode === "trackpad" && frame && at ? (
          <View
            pointerEvents="none"
            style={[
              styles.pointer,
              {
                borderColor: c.primary,
                left: at.left + (pointer ?? centre(frame)).x * at.scale - 8,
                top: at.top + (pointer ?? centre(frame)).y * at.scale - 8,
              },
            ]}
          />
        ) : null}
      </View>
      <View style={[styles.bar, { paddingBottom: insets.bottom + 8, borderTopColor: c.border }]}>
        {error ? (
          <View accessibilityLiveRegion="polite">
            <Txt v="meta" tone="danger">
              {error}
            </Txt>
          </View>
        ) : null}
        {control ? (
          <>
            <Segmented
              label="How touches work"
              value={mode}
              onChange={(next) => {
                setMode(next);
                setPointer(undefined);
              }}
              options={[
                { value: "touch", label: "Touch" },
                { value: "trackpad", label: "Trackpad" },
              ]}
            />
            <TextInput
              // The box stays empty: each letter goes straight to the page and is not kept, so
              // a password typed here never sits on the phone's screen.
              value=""
              onChangeText={(next) => send(typeText(next))}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === "Backspace") send(press("Backspace"));
              }}
              onSubmitEditing={() => send(press("Enter"))}
              blurOnSubmit={false}
              placeholder="Type on the page"
              placeholderTextColor={c["text-dim"]}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="go"
              accessibilityLabel="Type on the page"
              style={[
                styles.input,
                {
                  color: c.text,
                  borderColor: c["border-control"],
                  backgroundColor: c["bg-raised"],
                  fontFamily: sans,
                },
              ]}
            />
          </>
        ) : null}
        <Button
          label={control ? "Hand back" : "Take over"}
          kind={control ? "secondary" : "primary"}
          onPress={() => void toggle()}
          disabled={busy || !online || empty}
          expanded
        />
      </View>
    </View>
  );
}

const screenActions = [
  { name: "activate", label: "Click" },
  { name: "scrollUp", label: "Scroll up" },
  { name: "scrollDown", label: "Scroll down" },
];

const centre = (page: Box): Point => ({
  x: Math.round(page.width / 2),
  y: Math.round(page.height / 2),
});

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { flex: 1, minWidth: 0 },
  screen: { flex: 1, overflow: "hidden" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  centred: { textAlign: "center" },
  pointer: {
    position: "absolute",
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
  },
  bar: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    minHeight: touch,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    fontSize: 16,
  },
});
