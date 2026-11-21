// O4: voice mode. The same loop as a call on the Mac: a pause sends what you said, the reply is read
// aloud, and talking over it stops it. Opened from the chat's header; End closes it.
import {
  CallMachine,
  type CallState,
  callDuration,
  SpeechQueue,
  speechPieces,
  speechText,
  VOICE_CALL_GUIDANCE,
} from "@zoltbot/protocol";
import { chiefThreadId } from "@zoltbot/ui/chief/data";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { transcript } from "../../data/timeline";
import { text } from "../../data/view";
import { newReplies } from "../../data/voice";
import { attempts } from "../../state/actions";
import { useLink, useSnapshot } from "../../state/link";
import { useTheme } from "../../theme";
import { BotAvatar } from "../../ui/BotAvatar";
import { Button, Txt } from "../../ui/kit";
import { replyEngine, setCalling } from "../../ui/read-aloud";
import { allowListening, listen } from "../../ui/speech";

const TICK_MS = 100;
const DENIED = "Allow the microphone and speech recognition for Zoltbot in Settings.";

/**
 * Calls the Mac without the screen's busy gate. Each utterance has its own key: saying "yes" twice
 * sends twice, while a dropped link still replays the same command.
 */
async function call(
  key: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const client = useLink.getState().client;
  if (!client) throw new Error("Zoltbot isn’t connected.");
  return attempts.run(key, params, (sent, id) => client.getState().call(method, sent, id));
}

/** Quick failures in a row before the call gives up on listening. */
const MAX_RESTARTS = 5;
const SAY_PROBLEM_MS = 4000;

export default function VoiceMode() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const thread = (snapshot.entities.thread ?? []).find((row) => row.id === id);
  const title = text(thread?.title) || "Chat";
  const rows = transcript(snapshot, id);
  const [state, setState] = useState<CallState>("listening");
  const [muted, setMuted] = useState(false);
  // Why the call ended, or a send that failed while it goes on.
  const [problem, setProblem] = useState("");
  const [slip, setSlip] = useState("");
  const [now, setNow] = useState(Date.now());
  const startedAt = useRef(Date.now()).current;
  // Replies already in the chat when the call starts aren't read.
  const seen = useRef<Set<string>>(undefined);
  seen.current ??= new Set(rows.map((row) => row.id));
  const texts = useRef(new Map<string, string>());
  const loop = useRef<{
    machine: CallMachine;
    queue: SpeechQueue;
    ended(): boolean;
    end(): void;
    hush(): void;
  }>(undefined);

  useEffect(() => {
    let session: { stop(): void; abort(): void } | undefined;
    let ended = false;
    let generation = 0;
    let sent = 0;
    // The agent is told this is a call until a message carrying that reaches it.
    let guidance: "none" | "sending" | "done" = "none";
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let slipTimer: ReturnType<typeof setTimeout> | undefined;
    const say = (line: string) => AccessibilityInfo.announceForAccessibility(line);
    const fail = (line: string) => {
      setProblem(line);
      say(line);
      finish();
    };
    const hear = async () => {
      clearTimeout(retry);
      session?.abort();
      session = undefined;
      if (ended || machine.muted) return;
      const mine = ++generation;
      const heardAt = Date.now();
      const started = await listen(
        { continuous: true, voiceChat: true },
        {
          partial: (said) => machine.heard(said, Date.now()),
          final: (said) => machine.final(said, Date.now()),
          ended: (error) => {
            // Superseded: muting, a newer session or the call ending did it on purpose.
            if (mine !== generation || ended || error === "superseded") return;
            session = undefined;
            if (error) return fail(error);
            // A session that ends at once over and over isn't going to hear anything.
            failures = Date.now() - heardAt < 2000 ? failures + 1 : 0;
            if (failures >= MAX_RESTARTS) return fail("Couldn’t keep listening.");
            retry = setTimeout(() => void hear(), failures ? 500 * 2 ** (failures - 1) : 0);
          },
        },
      );
      if (mine !== generation || ended) started?.abort();
      else session = started;
    };
    const machine = new CallMachine({
      send: (said) => {
        const guided = guidance === "none";
        if (guided) guidance = "sending";
        const input = [
          ...(guided ? [{ type: "text", text: VOICE_CALL_GUIDANCE }] : []),
          { type: "text", text: said },
        ];
        const key = `voice:${id}:${startedAt}:${++sent}`;
        call(key, "turn.send", { threadId: id, input, mode: "steer" }).then(
          () => {
            if (guided) guidance = "done";
          },
          (error: unknown) => {
            if (guided) guidance = "none";
            if (ended) return;
            const line = error instanceof Error ? error.message : String(error);
            setSlip(line);
            say(line);
            clearTimeout(slipTimer);
            slipTimer = setTimeout(() => setSlip(""), SAY_PROBLEM_MS);
          },
        );
      },
      stopSpeaking: () => queue.stop(),
      restart: () => void hear(),
      changed: (next, quiet) => {
        setState(next);
        setMuted(quiet);
      },
    });
    const queue = new SpeechQueue(replyEngine, {
      onReading: (reading) => {
        if (reading) machine.speaking(texts.current.get(reading) ?? "");
        else machine.replyDone();
      },
    });
    const finish = () => {
      if (ended) return;
      ended = true;
      setCalling(false);
      generation++;
      clearTimeout(retry);
      clearTimeout(slipTimer);
      machine.end();
      session?.abort();
      queue.stop();
      clearInterval(timer);
      const endedAt = Date.now();
      if (endedAt - startedAt >= 1000)
        void call(`voice.call.log:${id}:${startedAt}`, "voice.call.log", {
          threadId: id,
          startedAt: new Date(startedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
        }).catch(() => undefined);
    };
    const timer = setInterval(() => {
      machine.tick(Date.now());
      setNow(Date.now());
    }, TICK_MS);
    loop.current = {
      machine,
      queue,
      ended: () => ended,
      end: finish,
      // Muted: the microphone is off, not just ignored.
      hush: () => {
        generation++;
        clearTimeout(retry);
        session?.abort();
        session = undefined;
      },
    };
    setCalling(true);
    void allowListening().then((allowed) => {
      if (ended) return;
      if (allowed) void hear();
      else fail(DENIED);
    });
    return finish;
  }, [id, startedAt]);

  // Each reply that finishes during the call is read in turn.
  useEffect(() => {
    const current = loop.current;
    if (!current || !seen.current || current.ended()) return;
    for (const reply of newReplies(rows, seen.current)) {
      const words = speechText(reply.text, Intl.DateTimeFormat().resolvedOptions().locale);
      texts.current.set(reply.id, words);
      current.queue.enqueue(reply.id, speechPieces(words));
    }
  });

  const end = () => {
    loop.current?.end();
    router.back();
  };
  const toggleMute = () => {
    const machine = loop.current?.machine;
    if (!machine) return;
    if (machine.muted) machine.unmute();
    else {
      machine.mute();
      loop.current?.hush();
    }
  };
  const status = problem
    ? problem
    : slip
      ? slip
      : state === "speaking"
        ? "Speaking"
        : muted || state === "ended"
          ? ""
          : "Listening";

  return (
    <View
      style={[
        styles.page,
        {
          backgroundColor: c["bg-page"],
          paddingTop: insets.top + 48,
          paddingBottom: insets.bottom + 24,
        },
      ]}
    >
      <View style={styles.who}>
        <BotAvatar id={id} size={96} zolt={chiefThreadId(snapshot.entities) === id} />
        <Txt v="largeTitle" accessibilityRole="header" lines={2} style={styles.center}>
          {title}
        </Txt>
        <Txt v="body" tone={problem || slip ? "danger" : "muted"} style={styles.center}>
          {status}
        </Txt>
        {/* Changes every second; screen readers skip it. */}
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Txt v="meta" tone="muted">
            {callDuration(now - startedAt)}
          </Txt>
        </View>
      </View>
      <View style={styles.actions}>
        <Button
          label={muted ? "Unmute" : "Mute"}
          onPress={toggleMute}
          disabled={state === "ended"}
          style={styles.action}
        />
        {/* Red with the page's colour for its words, which keeps contrast in both themes. */}
        <Pressable
          onPress={end}
          accessibilityRole="button"
          accessibilityLabel="End"
          style={({ pressed }) => [
            styles.action,
            styles.end,
            { backgroundColor: c.danger, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Txt v="bodyMedium" style={{ color: c["bg-page"], fontWeight: "600" }}>
            End
          </Txt>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: "space-between", paddingHorizontal: 24 },
  who: { alignItems: "center", gap: 12 },
  center: { textAlign: "center" },
  actions: { flexDirection: "row", gap: 12 },
  action: { flex: 1 },
  end: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 12 },
});
