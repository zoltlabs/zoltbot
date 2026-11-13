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

/** Stops any live or failed session handle for a thread before archiving or deleting it. */
export async function stopThreadRuntime(
  entries: Map<string, RuntimeEntry>,
  openingMap: ReadonlyMap<string, Promise<unknown>>,
  failedHandles: Map<string, AgentSession>,
  onError: ((code: string) => void) | undefined,
  threadId: string,
  forceCleanup = false,
): Promise<void> {
  const opening = openingMap.get(threadId);
  if (opening) await opening.catch(() => undefined);
  const entry = entries.get(threadId);
  if (entry) {
    entries.delete(threadId);
    try {
      await entry.worker.close();
    } catch {
      if (!forceCleanup) {
        failedHandles.set(threadId, entry.native);
        onError?.("runtime_cleanup_failed");
      }
    }
  }
  if (forceCleanup) {
    const failed = failedHandles.get(threadId);
    if (failed) {
      failedHandles.delete(threadId);
      await failed.close().catch(() => undefined);
    }
  }
}

/** Closes the owned live session matching `sessionId` after credential disconnection. */
export async function stopSessionRuntime(
  entries: Map<string, RuntimeEntry>,
  store: Store,
  sessionId: string,
): Promise<void> {
  for (const [threadId, entry] of entries) {
    const session = store.record("session", sessionId);
    if (session?.threadId !== threadId || entry.sessionId !== sessionId) continue;
    await entry.worker.close();
    if (entries.get(threadId) === entry) entries.delete(threadId);
    return;
  }
  const session = store.record("session", sessionId);
  if (session && !["closed", "failed"].includes(String(session.state)))
    throw new Error("connection_session_not_owned");
}

/** Settles opening sessions, worker closes, failed handles, and private contexts during shutdown. */
export async function closeAllRuntimes(
  entries: Map<string, RuntimeEntry>,
  opening: ReadonlyMap<string, Promise<unknown>>,
  failedHandles: Map<string, AgentSession>,
  commands: ReadonlySet<Promise<unknown>>,
  settlePrivateContexts: (() => Promise<void>) | undefined,
): Promise<void> {
  await Promise.allSettled([...opening.values()]);
  const closed = await Promise.allSettled(
    [...entries.values()]
      .map((entry) => entry.worker.close())
      .concat([...failedHandles.values()].map((native) => native.close())),
  );
  await Promise.allSettled([...commands]);
  await settlePrivateContexts?.();
  entries.clear();
  failedHandles.clear();
  if (closed.some((result) => result.status === "rejected"))
    throw new Error("runtime_close_failed");
}
