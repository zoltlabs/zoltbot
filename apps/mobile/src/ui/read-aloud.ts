// O5: Read aloud on the phone. One queue for the whole app: the phone's voice by default, or
// ElevenLabs through the Mac, which keeps the key and sends back each piece's audio.
import { type SpeechEngine, SpeechQueue, speechPieces, speechText } from "@zoltbot/protocol";
import { requireOptionalNativeModule } from "expo";
import { useEffect, useRef } from "react";
import { Alert } from "react-native";
import { create } from "zustand";
import type { TranscriptRow } from "../data/timeline";
import { newReplies, readableReply } from "../data/voice";
import { useLink } from "../state/link";
import { useVoicePrefs } from "../state/voice-prefs";
import { phoneEngine } from "./speech";

export { readableReply };

const FAILED = "Couldn’t read this aloud.";
const locale = () => Intl.DateTimeFormat().resolvedOptions().locale;

/** The words of a reply, in pieces the voices can take. */
export const replyPieces = (row: TranscriptRow) => speechPieces(speechText(row.text, locale()));

type Audio = typeof import("expo-audio");
type Files = typeof import("expo-file-system");
let modules: Promise<{ audio: Audio; files: Files } | undefined> | undefined;
function loadPlayer() {
  modules ??=
    requireOptionalNativeModule("ExpoAudio") && requireOptionalNativeModule("FileSystem")
      ? Promise.all([import("expo-audio"), import("expo-file-system")]).then(
          ([audio, files]) => ({ audio, files }),
          () => undefined,
        )
      : Promise.resolve(undefined);
  return modules;
}

let played = 0;
/** ElevenLabs through the Mac. The next piece is fetched while this one plays. */
export function macEngine(voiceId: string, rate: () => number): SpeechEngine {
  const fetchAudio = async (text: string) => {
    const client = useLink.getState().client;
    if (!client) throw new Error("Zoltbot isn’t connected.");
    const answer = (await client.getState().call("voice.speak", { text, voiceId })) as {
      data?: unknown;
    };
    if (typeof answer?.data !== "string") throw new Error(FAILED);
    return answer.data;
  };
  let ahead: { text: string; audio: Promise<string> } | undefined;
  return {
    prepare: (text) => {
      const audio = fetchAudio(text);
      audio.catch(() => undefined);
      ahead = { text, audio };
    },
    speak: async (text, signal) => {
      const audio = ahead?.text === text ? ahead.audio : fetchAudio(text);
      ahead = undefined;
      const loaded = await loadPlayer();
      if (!loaded) throw new Error(FAILED);
      const data = await audio;
      if (signal.aborted) return;
      const file = new loaded.files.File(loaded.files.Paths.cache, `speech-${++played}.mp3`);
      file.writeSync(data, { encoding: "base64" });
      const player = loaded.audio.createAudioPlayer({ uri: file.uri });
      try {
        player.setPlaybackRate(rate());
        await new Promise<void>((resolve, reject) => {
          // Audio that won't load, or a phone call taking the speaker, never finishes: give up
          // a little after it should have ended so the queue moves on.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settle = (error?: Error) => {
            clearTimeout(timer);
            listening.remove();
            signal.removeEventListener("abort", stop);
            if (error) reject(error);
            else resolve();
          };
          const stop = () => {
            player.pause();
            settle();
          };
          const expect = (seconds: number) => {
            clearTimeout(timer);
            timer = setTimeout(() => settle(new Error(FAILED)), seconds * 1000);
          };
          signal.addEventListener("abort", stop, { once: true });
          const listening = player.addListener("playbackStatusUpdate", (status) => {
            if (status.didJustFinish) return settle();
            if (status.isLoaded && status.duration > 0)
              expect((status.duration - status.currentTime) / Math.max(rate(), 0.5) + 5);
          });
          expect(15);
          try {
            player.play();
          } catch {
            settle(new Error(FAILED));
          }
        });
      } finally {
        player.remove();
        try {
          file.delete();
        } catch {
          // Gone already; the cache is the system's to clear.
        }
      }
    },
  };
}

export const useReading = create<{ id: string | undefined }>(() => ({ id: undefined }));

// The same failure, such as ElevenLabs out of credits, shows once a minute, not on every reply.
let lastError = { message: "", at: 0 };
/**
 * The voice replies are read in: ElevenLabs once a voice is picked and the Mac can be reached,
 * else the phone's.
 */
export function replyEngine(): SpeechEngine {
  const prefs = useVoicePrefs.getState();
  const rate = () => useVoicePrefs.getState().rate;
  const online = useLink.getState().client?.getState().status === "online";
  return prefs.engine === "elevenlabs" && prefs.voiceId && online
    ? macEngine(prefs.voiceId, rate)
    : phoneEngine(rate);
}

const queue = new SpeechQueue(replyEngine, {
  onReading: (id) => useReading.setState({ id }),
  onError: (_id, error) => {
    // A code from the Mac, such as voice_limit, isn't words to show.
    const said = error instanceof Error ? error.message : "";
    const message = said && !/^[a-z_]+$/.test(said) ? said : FAILED;
    if (message === lastError.message && Date.now() - lastError.at < 60_000) return;
    lastError = { message, at: Date.now() };
    Alert.alert(message);
  },
});

/** Reads one message now, ending whatever was being read. */
export function readAloud(row: TranscriptRow): void {
  const pieces = replyPieces(row);
  if (pieces.length) queue.readNow(row.id, pieces);
}

export function stopReading(): void {
  queue.stop();
}

// A call reads replies itself; nothing else talks over it.
let calling = false;
export function setCalling(on: boolean): void {
  calling = on;
  if (on) queue.stop();
}

/** With "Read new replies aloud" on, each reply that finishes while the chat is open is read. */
export function useReadNewReplies(threadId: string, rows: TranscriptRow[]): void {
  const readNew = useVoicePrefs((prefs) => prefs.readNew);
  const seen = useRef<{ threadId: string; ids: Set<string> }>(undefined);
  // Replies there when the chat opens, or when the setting is turned on, aren't read. A chat
  // still loading has no rows yet: what arrives first was there before.
  if (seen.current?.threadId !== threadId || !readNew || !seen.current.ids.size)
    seen.current = { threadId, ids: new Set(rows.map((row) => row.id)) };
  useEffect(() => {
    const known = seen.current;
    if (!known || !readNew) return;
    for (const reply of newReplies(rows, known.ids))
      if (!calling) queue.enqueue(reply.id, replyPieces(reply));
  });
  // Leaving the chat stops what it was reading.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the chat changes
  useEffect(() => () => queue.stop(), [threadId]);
}
