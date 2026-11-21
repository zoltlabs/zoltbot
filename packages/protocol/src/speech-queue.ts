// O1 and O5: one message is read at a time. A new reply waits for the one being read; Stop ends
// the current message and clears the rest. The engine (system voices or ElevenLabs) is supplied.

export interface SpeechEngine {
  /** Speaks one piece, resolving when it ends. Rejects when it can't be spoken. */
  speak(text: string, signal: AbortSignal): Promise<void>;
  /** Called with the next piece while one plays, so a network engine can fetch it early. */
  prepare?(text: string): void;
}

export interface SpeechQueueEvents {
  /** The message being read changed; undefined when nothing is. */
  onReading?(id: string | undefined): void;
  /** A message couldn't be read; the queue moves on. */
  onError?(id: string, error: unknown): void;
}

interface Entry {
  id: string;
  pieces: string[];
}

export class SpeechQueue {
  private readonly waiting: Entry[] = [];
  private current: { id: string; abort: AbortController } | undefined;

  constructor(
    private readonly engine: () => SpeechEngine,
    private readonly events: SpeechQueueEvents = {},
  ) {}

  /** The message being read, if any. */
  get reading(): string | undefined {
    return this.current?.id;
  }

  /** Ids waiting their turn, in order. */
  get queued(): string[] {
    return this.waiting.map((entry) => entry.id);
  }

  /** Reads now, cutting off whatever is playing and dropping the rest. */
  readNow(id: string, pieces: string[]): void {
    this.stop();
    this.enqueue(id, pieces);
  }

  /** Reads after the messages ahead of it. A message already read or waiting isn't added twice. */
  enqueue(id: string, pieces: string[]): void {
    if (!pieces.length || this.current?.id === id || this.waiting.some((e) => e.id === id)) return;
    this.waiting.push({ id, pieces });
    if (!this.current) void this.next();
  }

  /** Stops the message being read and clears the queue. */
  stop(): void {
    this.waiting.length = 0;
    const current = this.current;
    this.current = undefined;
    current?.abort.abort();
    if (current) this.events.onReading?.(undefined);
  }

  private async next(): Promise<void> {
    const entry = this.waiting.shift();
    if (!entry) {
      this.events.onReading?.(undefined);
      return;
    }
    const abort = new AbortController();
    const mine = { id: entry.id, abort };
    this.current = mine;
    this.events.onReading?.(entry.id);
    try {
      const engine = this.engine();
      for (const [index, piece] of entry.pieces.entries()) {
        if (abort.signal.aborted) return;
        const next = entry.pieces[index + 1];
        const speaking = engine.speak(piece, abort.signal);
        try {
          if (next) engine.prepare?.(next);
        } catch {
          // Fetching ahead is only a head start; the piece is fetched again when its turn comes.
        }
        await speaking;
      }
    } catch (error) {
      if (!abort.signal.aborted) this.events.onError?.(entry.id, error);
    } finally {
      // Stop or Read now already moved on; only the entry still current starts the next.
      if (this.current === mine) {
        this.current = undefined;
        void this.next();
      }
    }
  }
}
