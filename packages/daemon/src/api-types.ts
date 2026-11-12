import type { Command } from "@zoltbot/core/commands";
import type { DomainEvent, InteractionAnswer } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { GitHubClient } from "../../github/src/client.js";
import type { InteractionEngine, InteractionHost } from "./interaction-engine.js";
import type { Logger, Redactor } from "./logging.js";
import type { PrivateVault } from "./private-context.js";
import type { PrivateInputGuard } from "./private-input.js";
import type { QuickChatHostOptions } from "./quick-chat/service.js";
import type { RuntimeHost } from "./session-manager.js";
import type { SetupService } from "./setup-api.js";

export interface SetupContext {
  snapshot(): ReturnType<Store["snapshot"]>;
  applyImport(receipt: unknown): Promise<void>;
}
export interface RuntimeContext {
  views?: import("./views/registry.js").ViewRegistry;
  store: Store;
  secrets?: PrivateVault;
  privacy: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
  wake(threadId: string): Promise<void>;
  /** Stops a running turn, for host tools acting on another chat after approval. */
  interrupt?(threadId: string, turnId: string, commandId: string): Promise<unknown>;
  /** Sends answers the person confirmed, as theirs (the main agent relays them). */
  answer?(
    items: { id: string; version: number; answer: InteractionAnswer }[],
    commandId: string,
  ): Promise<unknown>;
}
export interface OwnedRuntime extends RuntimeHost {
  loginInfo?(
    profileId: string,
  ): Promise<{ provider: string; command: string; configDirectory: string }>;
  close(): Promise<void>;
}
export interface DaemonOptions {
  dataDir: string;
  /** Absent by default. A separate cloud host receives no Local store or runtime context. */
  cloudRunner?(input: { dataDir: string; status(code: string): void }): { close(): Promise<void> };
  githubClient?: GitHubClient;
  githubPublishing?: import("./github/state.js").ShippingContext["publishing"];
  routineClock?: () => string;
  routinePollMs?: number;
  eventRoutineTransport?: import("../../github/src/transport.js").GitHubTransport;
  redactor?: Redactor;
  origins?: string[];
  replayLimit?: number;
  setup?: SetupService | ((context: SetupContext) => SetupService);
  interactionHost?: InteractionHost;
  runtimeHost?: RuntimeHost;
  runtime?: (context: RuntimeContext) => OwnedRuntime;
  secrets?: PrivateVault;
  /** Quick Chat inference. ChatGPT plan usage stays off unless this build is eligible. */
  quickChat?: QuickChatHostOptions;
  /** Relay link (D124). Tuning is for tests; defaultUrl is the build's relay (ZOLTBOT_RELAY_URL). */
  relay?: {
    retry?: { baseMs: number; maxMs: number };
    pushDelayMs?: number;
    pingMs?: number;
    defaultUrl?: string;
  };
}
export interface Daemon {
  url: string;
  token: string;
  dataDir: string;
  store: Store;
  logger: Logger;
  interactions: InteractionEngine | undefined;
  close(): Promise<void>;
  dispatch(command: Command, commandId: string): unknown;
}
