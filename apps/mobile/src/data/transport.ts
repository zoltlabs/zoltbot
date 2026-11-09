import type { DomainEvent } from "@zoltbot/protocol";

export type Row = Record<string, unknown>;
export type Snapshot = {
  seq: number;
  entities: Record<string, Row[]>;
  counters: Record<string, number>;
};

/**
 * How far the link to the Mac got. `pairing` waits for the person to allow this phone on the Mac,
 * `mac_offline` means the relay is up but the Mac is not, `offline` means the phone cannot reach
 * the relay at all.
 */
export type LinkStatus = "connecting" | "pairing" | "online" | "mac_offline" | "offline";

/** The call may or may not have run on the Mac: it timed out or the link dropped mid-flight. */
export class OutcomeUnknownError extends Error {
  readonly outcomeUnknown = true;
}

export interface TransportHandlers {
  status(status: LinkStatus, detail?: { lastSeenAt?: string; error?: string }): void;
  event(event: DomainEvent): void;
  /** The six digit code from the handshake, shown while the person confirms on the Mac. */
  confirmCode?(code: string): void;
}

/**
 * One way to reach zoltd. The client sees the same JSON-RPC methods and events through all of
 * them, so the fake (sample data) and the relay can be swapped without touching screens.
 */
export interface Transport {
  readonly kind: "fake" | "relay";
  start(handlers: TransportHandlers): void;
  /**
   * `commandId` names one user action. Sending it again after a timeout replays the Mac's stored
   * receipt instead of running the command twice.
   */
  call(method: string, params: unknown, commandId?: string): Promise<unknown>;
  stop(): void;
}
