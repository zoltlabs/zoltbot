// O5: how this phone reads replies aloud. Kept on the phone, like the Mac keeps its own.
import { create } from "zustand";

export type PhoneSpeechEngine = "phone" | "elevenlabs";
export const PHONE_SPEECH_RATES = [0.75, 1, 1.5, 2] as const;

export interface VoicePrefs {
  /** Read each new reply in the open chat. */
  readNew: boolean;
  engine: PhoneSpeechEngine;
  /** The ElevenLabs voice, from the key on the Mac. */
  voiceId: string;
  rate: number;
}

const DEFAULTS: VoicePrefs = { readNew: false, engine: "phone", voiceId: "", rate: 1 };
const KEY = "zoltbot.voice";

/** Reads saved preferences, dropping anything that isn't one. */
export function parseVoicePrefs(saved: string | null | undefined): VoicePrefs {
  try {
    const value = JSON.parse(saved ?? "{}") as Partial<Record<keyof VoicePrefs, unknown>>;
    return {
      readNew: value.readNew === true,
      engine: value.engine === "elevenlabs" ? "elevenlabs" : "phone",
      voiceId:
        typeof value.voiceId === "string" && /^[A-Za-z0-9]{1,64}$/.test(value.voiceId)
          ? value.voiceId
          : "",
      rate: PHONE_SPEECH_RATES.find((rate) => rate === value.rate) ?? 1,
    };
  } catch {
    return DEFAULTS;
  }
}

interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

// Changes made before the saved preferences load are kept on top of them, then saved.
let loaded = false;
let early: Partial<VoicePrefs> = {};

export const useVoicePrefs = create<VoicePrefs & { set(patch: Partial<VoicePrefs>): void }>(
  (set, get) => ({
    ...DEFAULTS,
    set: (patch) => {
      set(patch);
      if (!loaded) {
        early = { ...early, ...patch };
        return;
      }
      save(get());
    },
  }),
);

function save({ readNew, engine, voiceId, rate }: VoicePrefs): void {
  void store()
    .then((saved) => saved?.set(KEY, JSON.stringify({ readNew, engine, voiceId, rate })))
    .catch(() => undefined);
}

let saved: Promise<Store | undefined> | undefined;
function store(): Promise<Store | undefined> {
  saved ??= import("expo-secure-store").then(
    (module) => ({
      get: (key) => module.getItemAsync(key),
      set: (key, value) => module.setItemAsync(key, value),
    }),
    () => undefined,
  );
  return saved;
}

/** Loads what was saved; called once at launch. */
export function loadVoicePrefs(): void {
  void store()
    .then((saved) => saved?.get(KEY))
    .catch(() => undefined)
    .then((text) => {
      loaded = true;
      useVoicePrefs.setState({ ...parseVoicePrefs(text), ...early });
      if (Object.keys(early).length) save(useVoicePrefs.getState());
      early = {};
    });
}
