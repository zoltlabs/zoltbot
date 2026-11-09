import { pairingOfferTtlMs } from "@zoltbot/link";

export interface Rate {
  /** Sustained allowance per second. */
  perSecond: number;
  /** Largest burst. */
  burst: number;
}

export interface Limits {
  /** Time a client has to send `hello` after the challenge. */
  helloTimeoutMs: number;
  frames: Record<"mac" | "device", Rate>;
  bytes: Record<"mac" | "device", Rate>;
  /** Bad, oversize or rate limited frames a connection may send before it is closed. */
  maxStrikes: number;
  /** Device sign ins one pairing offer accepts. */
  offerAttempts: number;
  /** Longest pairing window a Mac may open. */
  offerTtlMs: number;
  /** Ping interval. A connection that misses one pong is dropped. */
  heartbeatMs: number;
  /** A receiver this far behind is dropped rather than buffered without end. */
  maxBufferedBytes: number;
}

export const defaultLimits: Limits = {
  helloTimeoutMs: 10_000,
  frames: { mac: { perSecond: 200, burst: 400 }, device: { perSecond: 50, burst: 100 } },
  bytes: {
    mac: { perSecond: 8 * 1_048_576, burst: 16 * 1_048_576 },
    device: { perSecond: 2 * 1_048_576, burst: 4 * 1_048_576 },
  },
  maxStrikes: 20,
  offerAttempts: 5,
  offerTtlMs: pairingOfferTtlMs,
  heartbeatMs: 30_000,
  maxBufferedBytes: 16 * 1_048_576,
};

/** A token bucket. `take` returns false when the cost does not fit. */
export class Bucket {
  private tokens: number;
  private at: number;

  constructor(
    private readonly rate: Rate,
    private readonly now: () => number,
  ) {
    this.tokens = rate.burst;
    this.at = now();
  }

  take(cost = 1) {
    const now = this.now();
    this.tokens = Math.min(
      this.rate.burst,
      this.tokens + ((now - this.at) / 1000) * this.rate.perSecond,
    );
    this.at = now;
    if (cost > this.tokens) return false;
    this.tokens -= cost;
    return true;
  }
}
