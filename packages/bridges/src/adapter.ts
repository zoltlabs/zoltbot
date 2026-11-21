// I1: the contract every chat app bridge implements. Adapters only talk to their app; routing,
// allow lists and turns live in the daemon.
import type { BridgeProblem } from "@zoltbot/protocol";

/** Where a reply goes, in the adapter's own terms. JSON only, so a restart can still answer. */
export type ReplyTarget = Record<string, string | number | boolean>;

export interface InboundAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

export interface InboundMessage {
  /** The app's message id; unique within the bridge, so a redelivery is ignored. */
  id: string;
  place: { id: string; label: string; direct: boolean };
  sender: { id: string; name: string };
  text: string;
  attachments?: InboundAttachment[];
  reply: ReplyTarget;
}

export interface OutboundMessage {
  text: string;
  /** Post under an agent's name and picture, where the app allows it. */
  as?: { name: string; iconUrl?: string };
}

export interface BridgeAdapter {
  /** Resolves once connected. Rejects with a BridgeError when it can't. */
  start(): Promise<void>;
  stop(): Promise<void>;
  send(target: ReplyTarget, message: OutboundMessage): Promise<void>;
  onMessage(handler: (message: InboundMessage) => void): void;
  /** Called when a live connection drops; the supervisor reconnects. */
  onDisconnect(handler: (error?: unknown) => void): void;
  /** The account the bot runs as, such as a workspace or bot user name, once connected. */
  account?(): string | undefined;
}

/** A failure the owner has to fix (a refused token) doesn't retry; a network one does. */
export class BridgeError extends Error {
  constructor(
    readonly problem: BridgeProblem,
    message: string = problem,
  ) {
    super(message);
  }
  get permanent() {
    return this.problem !== "network";
  }
}

export function problemOf(error: unknown): BridgeProblem {
  return error instanceof BridgeError ? error.problem : "network";
}
