// O4 and O5: the phone's speech recognizer and voices. Both are native modules; a build without
// them shows no microphone and no voice mode instead of failing to open the chat.
import type { SpeechEngine } from "@zoltbot/protocol";
import { requireOptionalNativeModule } from "expo";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

type Recognition = typeof import("expo-speech-recognition");
type Speech = typeof import("expo-speech");

let recognition: Promise<Recognition | undefined> | undefined;
let speech: Promise<Speech | undefined> | undefined;

/** The recognizer, or undefined in a build without it. */
export function loadRecognition(): Promise<Recognition | undefined> {
  recognition ??= requireOptionalNativeModule("ExpoSpeechRecognition")
    ? import("expo-speech-recognition").catch(() => undefined)
    : Promise.resolve(undefined);
  return recognition;
}

/** The system voices, or undefined in a build without them. */
export function loadSpeech(): Promise<Speech | undefined> {
  speech ??= requireOptionalNativeModule("ExpoSpeech")
    ? import("expo-speech").catch(() => undefined)
    : Promise.resolve(undefined);
  return speech;
}

/** Whether this build can listen; false until known. */
export function useCanListen(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    let live = true;
    void loadRecognition().then(
      (module) =>
        live && setCan(Boolean(module?.ExpoSpeechRecognitionModule.isRecognitionAvailable())),
    );
    return () => {
      live = false;
    };
  }, []);
  return can;
}

/** Asks once for the microphone and speech recognition; true when both are allowed. */
export async function allowListening(): Promise<boolean> {
  const module = await loadRecognition();
  if (!module) return false;
  const answer = await module.ExpoSpeechRecognitionModule.requestPermissionsAsync();
  return answer.granted;
}

export interface Listener {
  partial(text: string): void;
  final(text: string): void;
  /**
   * The session is over: it stopped on its own or after stop(), failed (`error` set), or a newer
   * session took the recognizer ("superseded"). Called once.
   */
  ended(error?: string): void;
}

interface Session {
  listener: Listener;
  subscriptions: { remove(): void }[];
}
let current: Session | undefined;

// The native events carry no session id, so a new session starts only once the last one has
// ended: every event after that is the new one's.
let running = false;
let settled = Promise.resolve();
let markSettled = () => {};
let watching = false;

/** Ends a session once: no more events reach its listener. */
function close(session: Session, error?: string) {
  if (current === session) current = undefined;
  for (const subscription of session.subscriptions.splice(0)) subscription.remove();
  session.listener.ended(error);
}

/** Starts listening, ending any session already running. Undefined when it can't listen. */
export async function listen(
  options: { continuous: boolean; voiceChat?: boolean },
  listener: Listener,
): Promise<{ stop(): void; abort(): void } | undefined> {
  const module = await loadRecognition();
  if (!module) return undefined;
  const native = module.ExpoSpeechRecognitionModule;
  if (!watching) {
    watching = true;
    native.addListener("end", () => {
      running = false;
      markSettled();
    });
  }
  const before = current;
  const session: Session = { listener, subscriptions: [] };
  current = session;
  if (before) close(before, "superseded");
  if (running) {
    native.abort();
    // An abort that never reports its end mustn't hold the microphone forever.
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
  // A newer session took over while this one waited.
  if (current !== session) return undefined;
  const mine = () => current === session;
  let stopping = false;
  session.subscriptions.push(
    native.addListener("result", (event) => {
      if (!mine()) return;
      const said = event.results[0]?.transcript ?? "";
      if (event.isFinal) listener.final(said);
      else listener.partial(said);
    }),
    native.addListener("error", (event) => {
      // Aborted: this session being ended on purpose.
      if (!mine() || event.error === "aborted") return;
      // Silence isn't a failure; the caller starts listening again. Android names it
      // "speech-timeout", and may report "client" for a stop() asked for on purpose.
      const quiet =
        event.error === "no-speech" ||
        event.error === "speech-timeout" ||
        (stopping && event.error === "client");
      close(session, quiet ? undefined : event.error);
    }),
    native.addListener("end", () => {
      if (mine()) close(session);
    }),
  );
  running = true;
  settled = new Promise((resolve) => {
    markSettled = resolve;
  });
  native.start({
    lang: Intl.DateTimeFormat().resolvedOptions().locale,
    interimResults: true,
    continuous: options.continuous,
    addsPunctuation: true,
    // On-device when this phone can, so speech stays on it.
    requiresOnDeviceRecognition: native.supportsOnDeviceRecognition(),
    // On a call the speaker plays replies: voice processing cancels their echo, and the loud
    // speaker (or headphones) is used rather than the earpiece.
    ...(options.voiceChat
      ? {
          iosVoiceProcessingEnabled: true,
          iosCategory: {
            category: "playAndRecord",
            categoryOptions: ["defaultToSpeaker", "allowBluetooth"],
            mode: "voiceChat",
          },
        }
      : {}),
  });
  return {
    stop: () => {
      if (!mine()) return;
      stopping = true;
      native.stop();
    },
    abort: () => {
      if (!mine()) return;
      close(session, "superseded");
      native.abort();
    },
  };
}

/** The phone's system voice, one piece at a time, for the shared reading queue. */
export function phoneEngine(rate: () => number = () => 1): SpeechEngine {
  return {
    speak: (text, signal) =>
      new Promise<void>((resolve, reject) => {
        void loadSpeech().then((module) => {
          if (!module) return reject(new Error("Couldn’t read this aloud."));
          if (signal.aborted) return resolve();
          const stop = () => void module.stop();
          signal.addEventListener("abort", stop, { once: true });
          const done = () => {
            signal.removeEventListener("abort", stop);
            resolve();
          };
          module.speak(text, {
            rate: rate(),
            onDone: done,
            onStopped: done,
            onError: () => {
              signal.removeEventListener("abort", stop);
              reject(new Error("Couldn’t read this aloud."));
            },
          });
        });
      }),
  };
}

/**
 * O4: the composer's microphone. Words appear in the draft as they're heard, after what was there.
 * Typing, sending or leaving the chat ends dictation: the composer calls `cancel` for the first two.
 */
export function useDictation(draft: string, setDraft: (text: string) => void, scope: string) {
  const [listening, setListening] = useState(false);
  const session = useRef<{ stop(): void; abort(): void }>(undefined);
  const starting = useRef(0);
  const before = useRef("");
  const latest = useRef(draft);
  latest.current = draft;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      session.current?.abort();
    };
  }, []);
  // Another chat: what was being said belonged to the last one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chat changes
  useEffect(
    () => () => {
      starting.current++;
      session.current?.abort();
    },
    [scope],
  );
  const write = (said: string) => {
    const lead = before.current && !/\s$/.test(before.current) && said ? " " : "";
    setDraft(`${before.current}${lead}${said}`);
  };
  const start = async () => {
    if (session.current) return undefined;
    const attempt = ++starting.current;
    if (!(await allowListening()))
      return "Allow the microphone and speech recognition for Zoltbot in Settings.";
    if (!live.current || attempt !== starting.current) return undefined;
    before.current = latest.current;
    const started = await listen(
      { continuous: true },
      {
        partial: write,
        final: write,
        ended: (error) => {
          session.current = undefined;
          if (live.current) setListening(false);
          // A recognizer that fails, rather than one stopped on purpose, says so.
          if (error && error !== "superseded" && live.current)
            Alert.alert("Dictation stopped", "Try again, or type instead.");
        },
      },
    );
    if (!started) return undefined;
    if (!live.current || attempt !== starting.current) {
      started.abort();
      return undefined;
    }
    session.current = started;
    setListening(true);
    return undefined;
  };
  const stop = () => session.current?.stop();
  /** Ends dictation and keeps the draft as it is. */
  const cancel = () => {
    starting.current++;
    session.current?.abort();
  };
  return { listening, start, stop, cancel };
}
