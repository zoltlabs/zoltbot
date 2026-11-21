// D2: short sounds when a task finishes, when an agent needs the owner, and on send. Made here
// from plain tones with Web Audio, so there are no sound files to license or ship.
import { createRoot, createSignal } from "solid-js";
import type { AgentEvent } from "../../../shared/ipc";
import { DEFAULT_PREFERENCES, type Preferences } from "../../../shared/preferences";

export type SoundName = "taskFinished" | "needsYou" | "messageSent";

export type SoundPreferences = Pick<
  Preferences,
  "sounds" | "soundTaskFinished" | "soundNeedsYou" | "soundMessageSent" | "soundVolume"
>;

const SWITCH: Record<SoundName, keyof SoundPreferences> = {
  taskFinished: "soundTaskFinished",
  needsYou: "soundNeedsYou",
  messageSent: "soundMessageSent",
};

/** Whether a sound may play under the owner's switches. */
export function soundOn(name: SoundName, prefs: SoundPreferences): boolean {
  return prefs.sounds && prefs.soundVolume > 0 && prefs[SWITCH[name]] === true;
}

export interface SoundContext {
  /** The window has focus. */
  focused: boolean;
  /** The chat on screen. */
  openBotId: string;
  /** The owner muted this agent's chat (A3). */
  muted: (botId: string) => boolean;
}

/**
 * The sound an agent event makes, if any. Nothing plays for the chat the owner is looking at, or
 * for a muted one.
 */
export function soundFor(event: AgentEvent, context: SoundContext): SoundName | undefined {
  if (event.type !== "turn-completed" && event.type !== "prompt") return undefined;
  if (event.type === "turn-completed" && event.status !== "completed") return undefined;
  const name: SoundName = event.type === "prompt" ? "needsYou" : "taskFinished";
  if (context.muted(event.botId)) return undefined;
  if (context.focused && context.openBotId === event.botId) return undefined;
  return name;
}

/** Each sound as notes: frequency in hertz, start and length in seconds. All end by 0.3 s. */
export const TONES: Record<SoundName, { type: OscillatorType; notes: [number, number, number][] }> =
  {
    // A rising fifth: done.
    taskFinished: {
      type: "sine",
      notes: [
        [659.25, 0, 0.11],
        [987.77, 0.1, 0.18],
      ],
    },
    // Two even taps: look over here.
    needsYou: {
      type: "triangle",
      notes: [
        [783.99, 0, 0.09],
        [783.99, 0.14, 0.12],
      ],
    },
    // One soft, falling blip: gone.
    messageSent: { type: "sine", notes: [[880, 0, 0.08]] },
  };

const [prefs, setPrefs] = createRoot(() =>
  createSignal<SoundPreferences>({ ...DEFAULT_PREFERENCES }),
);
export const soundPreferences = prefs;

/** How long a finished turn waits for another to start before it counts as the task finishing. */
const FINISH_SETTLE_MS = 600;

let audio: AudioContext | undefined;
/** Plays a sound now if the owner's switches allow it. */
export function playSound(name: SoundName): void {
  const current = prefs();
  if (!soundOn(name, current) || typeof AudioContext === "undefined") return;
  audio ??= new AudioContext();
  // Sleep or a new output device can leave it suspended.
  if (audio.state === "suspended") void audio.resume().catch(() => undefined);
  const start = audio.currentTime + 0.01;
  const tone = TONES[name];
  for (const [frequency, at, length] of tone.notes) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(frequency, start + at);
    if (name === "messageSent")
      oscillator.frequency.exponentialRampToValueAtTime(frequency / 2, start + at + length);
    // A quick rise and a smooth fall, so no note clicks.
    const peak = 0.25 * current.soundVolume;
    gain.gain.setValueAtTime(0.0001, start + at);
    gain.gain.exponentialRampToValueAtTime(peak, start + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + length);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start + at);
    oscillator.stop(start + at + length + 0.02);
  }
}

const pick = (value: Preferences): SoundPreferences => ({
  sounds: value.sounds,
  soundTaskFinished: value.soundTaskFinished,
  soundNeedsYou: value.soundNeedsYou,
  soundMessageSent: value.soundMessageSent,
  soundVolume: value.soundVolume,
});

let chosen: Partial<SoundPreferences> = {};
/** Saves a change to the sound switches. */
export function setSoundPreferences(patch: Partial<SoundPreferences>): void {
  chosen = { ...chosen, ...patch };
  setPrefs({ ...prefs(), ...patch });
  void window.openbot?.preferences?.set(patch).catch(() => undefined);
}

/** Plays the sound for each agent event that has one. Returns a cleanup. */
export function followSounds(context: {
  openBotId: () => string;
  muted: (botId: string) => boolean;
}): () => void {
  const preferences = window.openbot?.preferences;
  const take = (value: Preferences) => setPrefs({ ...pick(value), ...chosen });
  void preferences
    ?.get()
    .then(take)
    .catch(() => undefined)
    .finally(() => {
      chosen = {};
    });
  const offPreferences = preferences?.onChange(take);
  // A finished turn followed at once by another in the same chat (a queued message, a handover)
  // isn't the task finishing: wait a moment before the chime.
  const finishing = new Map<string, ReturnType<typeof setTimeout>>();
  const offEvents = window.openbot.agent.onEvent((event) => {
    if (event.type === "turn-started") {
      clearTimeout(finishing.get(event.botId));
      finishing.delete(event.botId);
      return;
    }
    const name = soundFor(event, {
      focused: document.hasFocus(),
      openBotId: context.openBotId(),
      muted: context.muted,
    });
    if (name !== "taskFinished") {
      if (name) playSound(name);
      return;
    }
    const botId = (event as { botId: string }).botId;
    clearTimeout(finishing.get(botId));
    finishing.set(
      botId,
      setTimeout(() => {
        finishing.delete(botId);
        playSound("taskFinished");
      }, FINISH_SETTLE_MS),
    );
  });
  return () => {
    for (const timer of finishing.values()) clearTimeout(timer);
    offEvents();
    offPreferences?.();
  };
}
