// O2 and O4: a voice call with an agent. The owner talks, a pause sends what they said, the reply
// is read aloud, and talking over the reply stops it. The Mac and the phone share this machine;
// each supplies its own recognizer and voice.

/** A pause this long after the last words heard ends what the owner said. */
export const UTTERANCE_SILENCE_MS = 800;

/** Sent once, with the first thing said on a call. Kept short: it counts toward the I9 budget. */
export const VOICE_CALL_GUIDANCE =
  "This is a voice call. Answer briefly in plain spoken sentences, without code, tables or lists.";

/** Whether a message part is the call's guidance, which chats don't show. */
export const isCallGuidance = (text: unknown) =>
  typeof text === "string" && text.trim() === VOICE_CALL_GUIDANCE;

/** Calls kept per chat; the oldest go first. */
export const MAX_CALLS = 50;
export const chatCallsKey = (threadId: string) => `chat.calls.${threadId}`;
export const chatCallsThread = (key: unknown) =>
  typeof key === "string" && key.startsWith("chat.calls.")
    ? key.slice("chat.calls.".length) || undefined
    : undefined;

export interface CallRecord {
  id: string;
  startedAt: string;
  endedAt: string;
}

/** The stored calls, oldest first, skipping anything malformed. */
export function readCalls(value: unknown): CallRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (call): call is CallRecord =>
      !!call &&
      typeof call === "object" &&
      typeof (call as CallRecord).id === "string" &&
      typeof (call as CallRecord).startedAt === "string" &&
      typeof (call as CallRecord).endedAt === "string",
  );
}

export function withCall(value: unknown, call: CallRecord): CallRecord[] {
  return [...readCalls(value).filter((c) => c.id !== call.id), call].slice(-MAX_CALLS);
}

/** "0:42", "12:05" or "1:02:05". */
export function callDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export type CallState = "listening" | "waiting" | "speaking" | "ended";

export interface CallEvents {
  /** Send what the owner said. `first` is true for the call's first message. */
  send(text: string, first: boolean): void;
  /** Stop reading the reply: the owner talked over it. */
  stopSpeaking(): void;
  /** Start hearing afresh, so words already sent or spoken aren't heard again. */
  restart(): void;
  /** The state or mute changed. */
  changed?(state: CallState, muted: boolean): void;
}

/** A word as compared with the reply: lower case, without punctuation. */
const plain = (token: string) => token.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
const words = (text: string) => text.split(/\s+/).map(plain).filter(Boolean);

/** Recent words judged for talking over a reply; old echo in the transcript doesn't count. */
const BARGE_WINDOW = 6;

export class CallMachine {
  state: CallState = "listening";
  muted = false;
  private heardText = "";
  private lastHeard = 0;
  private sentAny = false;
  // The reply's audio is playing; what the microphone hears may be its echo.
  private playing = false;
  private spoken = new Set<string>();
  // Where the owner's own words start in this stretch's transcript, after any echo before them.
  private offset = 0;

  constructor(private readonly events: CallEvents) {}

  /** Everything heard so far in this stretch of listening, as the recognizer has it now. */
  heard(text: string, at: number): void {
    if (this.state === "ended" || this.muted) return;
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (this.playing && this.state === "speaking") {
      // The Mac's speaker reaches its own microphone: recent words that match the reply are echo.
      const start = Math.max(0, tokens.length - BARGE_WINDOW);
      const recent = tokens.slice(start).map(plain).filter(Boolean);
      const own = recent.filter((word) => this.spoken.has(word)).length;
      if (recent.length < 2 || own * 2 >= recent.length) return;
      // Talked over: keep only the words from the first one that isn't the reply's.
      const first = tokens.findIndex((token, index) => {
        const word = plain(token);
        return index >= start && word && !this.spoken.has(word);
      });
      this.offset = first < 0 ? start : first;
      this.playing = false;
      this.set("listening");
      this.events.stopSpeaking();
    }
    const said = tokens.slice(this.offset).join(" ");
    if (!said) return;
    this.heardText = said;
    this.lastHeard = at;
  }

  /** The recognizer finished a stretch: send what it heard without waiting for the pause. */
  final(text: string, at: number): void {
    this.heard(text, at);
    if (this.state !== "speaking") this.flush();
  }

  /** Called often; sends once the owner has paused long enough. */
  tick(at: number): void {
    if (this.heardText && at - this.lastHeard >= UTTERANCE_SILENCE_MS) this.flush();
  }

  /** A reply started being read aloud. */
  speaking(text: string): void {
    if (this.state === "ended") return;
    // Words heard but not yet sent go first, before the speaker can blur them with echo.
    this.flush();
    this.playing = true;
    this.spoken = new Set(words(text));
    this.set("speaking");
  }

  /** The reply finished or was stopped. */
  replyDone(): void {
    const wasSpeaking = this.playing && this.state === "speaking";
    this.playing = false;
    this.spoken.clear();
    if (!wasSpeaking) return;
    this.set("listening");
    this.restart();
  }

  mute(): void {
    if (this.state === "ended" || this.muted) return;
    // Words already heard were meant to be said; they go before the microphone closes.
    this.flush();
    this.muted = true;
    this.events.changed?.(this.state, true);
  }

  unmute(): void {
    if (this.state === "ended" || !this.muted) return;
    this.muted = false;
    this.restart();
    this.events.changed?.(this.state, false);
  }

  end(): void {
    if (this.state === "ended") return;
    this.heardText = "";
    this.set("ended");
  }

  private flush(): void {
    const text = this.heardText;
    if (!text || this.state === "ended") return;
    this.heardText = "";
    const first = !this.sentAny;
    this.sentAny = true;
    this.set("waiting");
    this.restart();
    this.events.send(text, first);
  }

  private restart(): void {
    this.offset = 0;
    this.events.restart();
  }

  private set(state: CallState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.changed?.(state, this.muted);
  }
}
