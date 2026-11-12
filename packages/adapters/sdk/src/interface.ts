import type {
  AgentDefinition,
  AgentEvent,
  Capabilities,
  InteractionAnswer,
  NativeSessionInfo,
  PermissionProfile,
  UserInput,
} from "@zoltbot/protocol";

export interface AdapterManifest {
  id: string;
  displayName: string;
  testedVersions: string;
  binaryNames: string[];
  versionCommand: string[];
  staticCapabilities: Partial<Capabilities>;
  supportsConnections?: boolean;
  supportsLocalBrowserCli?: boolean;
  /** Verified session-scoped native plugin loading; no prompt injection fallback. */
  supportsNativeSkills?: boolean;
}
export interface ProbeResult {
  installed: boolean;
  broken: boolean;
  version?: string;
  login: "signed_in" | "signed_out" | "unknown";
}
export interface NativeForkTarget {
  sourceNativeId: string;
  sourceCwd: string;
  targetNativeId?: string;
  boundary: { kind: "latest" } | { kind: "before_user" | "after_turn"; nativeId: string };
}
export interface OpenOptions {
  /** Explicit source and destination identities. nativeId remains the resume identity. */
  fork?: NativeForkTarget;
  identity: { agentId: string; threadId: string };
  mode: "new" | "resume" | "fork";
  nativeId?: string;
  cwd: string;
  model?: string;
  effort?: string;
  permissionProfile: PermissionProfile;
  appendInstructions?: string;
  /** Positive evidence that a Zoltbot-created native session has never received a prompt. */
  firstPromptPending?: boolean;
  /** Already resolved in private daemon memory; adapters serialize their own native format. */
  connections?: readonly (
    | { name: string; kind: "https"; url: string; headers: Record<string, string> }
    | { name: string; kind: "stdio"; command: string; args: string[] }
  )[];
  /** Re-resolve only the frozen descriptors before a native client reconnects. */
  refreshConnections?(): Promise<NonNullable<OpenOptions["connections"]>>;
  /**
   * Keep the MCP servers and plugins the person configured in the tool itself, beside Zoltbot's
   * host tools. Off for workspace chats, which get only the connections Zoltbot granted them.
   */
  ownTools?: boolean;
  /** With ownTools: the person's MCP servers to leave out, by name, so their tools never load. */
  ownToolsOff?: readonly string[];
  managedSkills?: readonly { name: string; path: string; pluginPath: string; namespace: string }[];
  launchManifestId?: string;
  hostMcp: {
    url: string;
    token: string;
    /** For hosts that keep credentials exclusively in the native process environment. */
    tokenEnv?: string;
  };
  name?: string;
  budget?: { usd?: number };
  env?: Record<string, string>;
}
export interface SendReceipt {
  disposition: "started" | "queued" | "handled";
  id?: string;
}
export interface AgentSession {
  readonly capabilities: Capabilities;
  readonly nativeId: string | undefined;
  events(): AsyncIterable<AgentEvent>;
  send(input: UserInput, mode: "queue" | "steer"): Promise<SendReceipt>;
  interrupt(): Promise<void>;
  respond(interactionId: string, answer: InteractionAnswer): Promise<void>;
  setModel(model: string, effort?: string): Promise<void>;
  setMode(mode: string): Promise<void>;
  compact(instructions?: string): Promise<void>;
  rename(name: string): Promise<void>;
  contextUsage(): Promise<{ used?: number; size?: number } | undefined>;
  /** Present when capabilities.backgroundTasks is true. */
  stopBackground?(taskId: string): Promise<void>;
  /**
   * Present when capabilities.rewind is true. Restores tracked files to their state before the
   * user input of the given Zoltbot turn. dryRun reports the effect without changing files.
   */
  rewindFiles?(
    turnId: string,
    dryRun: boolean,
  ): Promise<{
    canRewind: boolean;
    files: string[];
    insertions?: number;
    deletions?: number;
    error?: string;
  }>;
  close(opts?: { keepNative?: boolean }): Promise<void>;
}
export interface AgentAdapter {
  readonly id: string;
  manifest(): AdapterManifest;
  /** Provider-owned native packaging; managed content itself stays provider-neutral. */
  nativeSkillLayout?(skill: { name: string; revision: number; hash: string }): {
    prefix: string;
    files: { path: string; content: string }[];
    namespace: string;
  };
  probe(def: AgentDefinition): Promise<ProbeResult>;
  listNativeSessions(def: AgentDefinition, filter: { cwd?: string }): Promise<NativeSessionInfo[]>;
  open(def: AgentDefinition, options: OpenOptions): Promise<AgentSession>;
}
