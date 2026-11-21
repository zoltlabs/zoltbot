// O1: reads agent replies aloud, one at a time. The Mac's own voices speak through the window's
// speechSynthesis; ElevenLabs audio comes from the daemon, which holds the key.
import { type SpeechEngine, SpeechQueue, speechPieces, speechText } from "@zoltbot/protocol";
import { createEffect, createRoot, createSignal } from "solid-js";
import { DEFAULT_PREFERENCES, type Preferences } from "../../../../shared/preferences";
import type { BotMessage } from "../../data";
import { showToast } from "../../kit";

export type VoicePreferences = Pick<
  Preferences,
  | "readAloud"
  | "speechEngine"
  | "speechVoice"
  | "elevenVoice"
  | "speechRate"
  | "pushToTalkKey"
  | "sendOnRelease"
>;

const [reading, setReading] = createRoot(() => createSignal<string | undefined>(undefined));
// O2: the chat on a call, whose replies are always read.
const [callChat, setCallChat] = createRoot(() => createSignal<string | undefined>(undefined));
export { setCallChat };
const [prefs, setPrefs] = createRoot(() =>
  createSignal<VoicePreferences>({ ...DEFAULT_PREFERENCES }),
);

/** The id of the message being read aloud, if any. */
export const readingMessageId = reading;
/** The saved voice settings. Reading them starts following the preference. */
export function voicePreferences(): VoicePreferences {
  void follow();
  return prefs();
}

let loaded: Promise<void> | undefined;
/** Loads the saved settings once and follows later changes; resolves once they're in. */
function follow(): Promise<void> {
  if (loaded) return loaded;
  const preferences = window.openbot?.preferences;
  if (!preferences) {
    loaded = Promise.resolve();
    return loaded;
  }
  preferences.onChange(setPrefs);
  const ready = preferences
    .get()
    .then((value) => void setPrefs(value))
    .catch(() => undefined);
  loaded = ready;
  return ready;
}

export function setVoicePreferences(patch: Partial<VoicePreferences>): void {
  void follow();
  setPrefs({ ...prefs(), ...patch });
  void window.openbot?.preferences?.set(patch).catch(() => undefined);
}

const live = new Set<SpeechSynthesisUtterance>();

/** The Mac's voices through speechSynthesis. Each piece ends when its utterance does. */
export function systemEngine(
  synth: SpeechSynthesis | undefined = globalThis.speechSynthesis,
  settings: () => VoicePreferences = prefs,
): SpeechEngine {
  return {
    speak: (text, signal) =>
      new Promise<void>((resolve, reject) => {
        if (!synth || typeof SpeechSynthesisUtterance === "undefined")
          return reject(new Error("Couldn’t read this aloud."));
        const utterance = new SpeechSynthesisUtterance(text);
        const voice = synth.getVoices().find((v) => v.voiceURI === settings().speechVoice);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        utterance.rate = settings().speechRate;
        // Held until it settles: Chromium can drop an unreferenced utterance and never end it.
        live.add(utterance);
        // A piece that never reports its end still lets the queue move on.
        const timer = setTimeout(
          () => done(),
          Math.max(15_000, (text.length * 200) / settings().speechRate),
        );
        const done = () => {
          clearTimeout(timer);
          live.delete(utterance);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          synth.cancel();
          done();
        };
        utterance.onend = done;
        utterance.onerror = (event) => {
          clearTimeout(timer);
          live.delete(utterance);
          signal.removeEventListener("abort", abort);
          // Cancelling ends the utterance with an "interrupted" or "canceled" error.
          if (signal.aborted || event.error === "interrupted" || event.error === "canceled")
            resolve();
          else reject(new Error("Couldn’t read this aloud."));
        };
        signal.addEventListener("abort", abort, { once: true });
        synth.speak(utterance);
      }),
  };
}

/** ElevenLabs through the daemon. The next piece is fetched while this one plays. */
export function elevenEngine(settings: () => VoicePreferences = prefs): SpeechEngine {
  const fetchAudio = (text: string) =>
    window.openbot.voice.speak({ text, voiceId: settings().elevenVoice });
  let ahead: { text: string; audio: Promise<Uint8Array> } | undefined;
  return {
    prepare: (text) => {
      const audio = fetchAudio(text);
      // A fetch nobody plays mustn't surface as an unhandled rejection.
      audio.catch(() => undefined);
      ahead = { text, audio };
    },
    speak: async (text, signal) => {
      const audio = ahead?.text === text ? ahead.audio : fetchAudio(text);
      ahead = undefined;
      const bytes = await audio;
      if (signal.aborted) return;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/mpeg" }));
      try {
        const player = new Audio(url);
        player.playbackRate = settings().speechRate;
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            player.pause();
            resolve();
          };
          signal.addEventListener("abort", stop, { once: true });
          player.onended = () => resolve();
          player.onerror = () => reject(new Error("Couldn’t read this aloud."));
          player.play().catch(reject);
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}

// The same failure, such as ElevenLabs out of credits, shows once a minute, not on every reply.
let lastError = { message: "", at: 0 };
const queue = new SpeechQueue(
  // ElevenLabs needs a voice; until one is picked, the Mac's voices read.
  () =>
    prefs().speechEngine === "elevenlabs" && prefs().elevenVoice ? elevenEngine() : systemEngine(),
  {
    onReading: setReading,
    onError: (_id, error) => {
      const message = error instanceof Error ? error.message : "Couldn’t read this aloud.";
      if (message === lastError.message && Date.now() - lastError.at < 60_000) return;
      lastError = { message, at: Date.now() };
      showToast({ message });
    },
  },
);

export const pieces = (message: BotMessage) =>
  speechPieces(speechText(message.body ?? "", navigator.language));

/** Whether a message has words to read: a finished agent reply, not a note or a side question. */
export const readable = (message: BotMessage) =>
  message.author === "bot" &&
  !message.streaming &&
  (message.kind === undefined || message.kind === "text") &&
  !message.progress &&
  !message.hidden &&
  !message.aside &&
  !message.notice &&
  !message.card &&
  Boolean(message.body?.trim());

/** Read aloud, or Stop reading when this message is the one being read. */
export function toggleReading(message: BotMessage): void {
  if (reading() === message.id) {
    queue.stop();
    return;
  }
  // The saved engine and speed apply even to the first message read after launch.
  void follow().then(() => queue.readNow(message.id, pieces(message)));
}

export function stopReading(): void {
  queue.stop();
}

/** O1 "Read new replies aloud": a reply that finishes while the setting is on waits its turn. */
export function readNewReply(message: BotMessage, onCall = false): void {
  if (!readable(message)) return;
  void follow().then(() => {
    if (onCall || prefs().readAloud) queue.enqueue(message.id, pieces(message));
  });
}

/**
 * Reads replies that finish in the open chat while "Read new replies aloud" is on: ones seen
 * streaming, or made after the chat opened. History that loads late isn't read.
 */
export function followNewReplies(messages: () => BotMessage[], chat: () => string | undefined) {
  void follow();
  const done = new Set<string>();
  const streamed = new Set<string>();
  let shown: string | undefined;
  let openedAt = Date.now();
  createEffect(() => {
    const id = chat();
    const list = messages();
    if (id !== shown) {
      shown = id;
      openedAt = Date.now();
      done.clear();
      streamed.clear();
    }
    for (const message of list) {
      if (message.streaming) streamed.add(message.turnId ?? message.id);
      if (!readable(message) || done.has(message.id)) continue;
      done.add(message.id);
      const made = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
      if (streamed.has(message.turnId ?? message.id) || made > openedAt)
        readNewReply(message, id !== undefined && callChat() === id);
    }
  });
}
