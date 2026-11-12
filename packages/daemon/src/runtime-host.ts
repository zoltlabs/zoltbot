import { randomUUID } from "node:crypto";
import type { AgentSession } from "@zoltbot/adapters-sdk";
import type { CommandContext, DomainState, Outcome } from "@zoltbot/core";
import type { AgentDefinition, DomainEvent, Interaction, Profile, Thread } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { ApprovalRoot } from "./approval-paths.js";
import type { InteractionEngine } from "./interaction-engine.js";
import type { Redactor } from "./logging.js";
import type { PrivateVault } from "./private-context.js";
import type { PrivateInputGuard } from "./private-input.js";
import type { Previous } from "./runtime-configuration.js";
import type { RuntimeStream, RuntimeWorker } from "./runtime-worker.js";

export interface PreparedRuntime {
  model?: string;
  effort?: string;
  configuration?: Record<string, unknown>;
  validateWorkspace?(): void;
  validateLaunch?(): void;
  onTurn?(turnId: string | undefined): void;
  cwd: string;
  estimate(text: string): number;
  fixedInjectedTokens?: number;
  firstTurnBrowser?: { text: string; bindingId: string; digest: string };
  firstTurnKnowledge?: { packId: string; text: string; tokens: number };
  privateContextRestored?: boolean;
  privateValues?: readonly string[];
  /** Use the supplied scoped redactor for all process logs and protocol frames. */
  open(input: {
    sessionId: string;
    mode: "new" | "resume" | "fork";
    fork?: import("@zoltbot/adapters-sdk").NativeForkTarget;
    nativeId?: string;
  }): Promise<AgentSession>;
}
export interface RuntimeHost {
  /** Prepare configuration only. Native processes may start only inside open. */
  prepare(
    input: {
      thread: Thread;
      comparePermission?: Profile["permissionProfile"] | undefined;
      routineInputs?: import("@zoltbot/protocol").Routine["template"]["inputs"] | undefined;
      profile: Profile;
      definition: AgentDefinition;
      previous?: Previous;
      launchConfiguration?: unknown;
    },
    redactor: Redactor,
  ): Promise<PreparedRuntime>;
}

export interface RuntimeEntry {
  sessionId: string;
  approvalRoot?: ApprovalRoot;
  worker: RuntimeWorker;
  native: AgentSession;
  redactor: Redactor;
  privateValues: Set<string>;
}

export interface SessionManagerOptions {
  observe?(
    threadId: string,
    sessionId: string,
  ): import("./runtime-observer.js").RuntimeObservationSink;
  store: Store;
  host: RuntimeHost;
  interactions?: () => Promise<InteractionEngine>;
  secrets?: PrivateVault;
  privacy?: PrivateInputGuard;
  publish(events: DomainEvent[]): void;
  stream?(update: RuntimeStream): void;
  onError?(code: string, diagnostic?: { frames: string[] }): void;
}

export function commitRuntime(
  options: Pick<SessionManagerOptions, "store" | "publish">,
  produce: (state: DomainState, context: CommandContext) => Outcome,
) {
  const commandId = `session:${randomUUID()}`,
    before = options.store.lastSeq();
  const receipt = options.store.dispatch(commandId, (state) =>
    produce(state, {
      commandId,
      at: new Date().toISOString(),
      actor: { kind: "system", id: "runtime" },
    }),
  );
  options.publish(options.store.eventsSince(before));
  return receipt.result;
}

export function runtimeEntryFor(
  entries: ReadonlyMap<string, RuntimeEntry>,
  store: Store,
  request: Interaction,
) {
  const entry = entries.get(request.threadId);
  const turn = request.turnId
    ? store.snapshot().turn?.find((row) => row.id === request.turnId)
    : undefined;
  if (!entry || (request.turnId && turn?.sessionId !== entry.sessionId))
    throw new Error("interaction_runtime_unavailable");
  return entry;
}
