import type { AgentSession } from "@zoltbot/adapters-sdk";
import type { InjectionFragment } from "@zoltbot/core";
import type { AgentEvent, DomainEvent, UsageSample } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { Redactor } from "./logging.js";
import type { RuntimeObservationSink } from "./runtime-observer.js";

export interface RuntimeStream {
  threadId: string;
  turnId: string;
  itemId: string;
  kind: "message" | "thought";
  text: string;
  complete: boolean;
  item?: Record<string, unknown>;
}
export interface RuntimeWorkerOptions {
  observe?: RuntimeObservationSink;
  store: Store;
  session: Pick<AgentSession, "events" | "send" | "close">;
  sessionId: string;
  threadId: string;
  agentId: string;
  redactor: Redactor;
  estimate(text: string): number;
  fixedInjectedTokens?: number;
  firstTurnBrowser?: { text: string; bindingId: string; digest: string };
  firstTurnKnowledge?: { packId: string; text: string; tokens: number };
  fragments?: readonly InjectionFragment[];
  baseline?: UsageSample;
  publish(events: DomainEvent[]): void;
  stream?(update: RuntimeStream): void;
  /** Display-safe event plus temporary native path evidence. Never persist the second argument. */
  interaction?(
    event: Extract<AgentEvent, { t: "interaction.requested" | "interaction.cleared" }>,
    approvalSourcePaths?: readonly string[],
  ): void | Promise<void>;
  heldInteractionIds?(): readonly string[];
  onTurn?(turnId: string | undefined): void;
  onCleanupFailure?(): void;
  onError?(code: string, diagnostic?: { frames: string[] }): void;
}
export interface Pending {
  id: string;
  attempt: string;
  injectedTokens: number;
}
