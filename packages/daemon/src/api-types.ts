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
  /** V2: saved logins the agents' `vault` tool types into pages. */
  vault?: import("./vault/api.js").VaultRuntime;
  store: Store;
  secrets?: PrivateVault;
  privacy: PrivateInputGuard;
  /** M8: each project's shared database. */
  projectData?: import("./project-data/databases.js").ProjectDatabases;
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
  /** The sign-in command for a definition, in an account's own config folder when given. */
  accountLoginInfo?(
    definitionId: string,
    configDirectory?: string,
  ): Promise<{ provider: string; command: string; configDirectory: string; slashCommand?: string }>;
  /** Whether a definition, in an account's config folder when given, is signed in. */
  accountLogin?(
    definitionId: string,
    configDirectory?: string,
  ): Promise<"signed_in" | "signed_out" | "unknown">;
  close(): Promise<void>;
}
export interface DaemonOptions {
  dataDir: string;
  /** Native account owner; no credentials or Local projections appear in daemon RPC. */
  nativeAccount?: import("./account-session/daemon.js").DaemonAccountOptions;
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
  /** V3: fake password-manager CLIs for tests; the real ones when absent. */
  vaultProviders?: import("./vault/providers.js").ProviderHost;
  /** Quick Chat inference. ChatGPT plan usage stays off unless this build is eligible. */
  quickChat?: QuickChatHostOptions;
  /** I1: chat app bridges. Tests pass fake adapters; the default build adds the real apps. */
  bridges?: import("./bridges/service.js").BridgeHostOptions;
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
