import { type AgentAdapter, NativeWriters, type OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, NativeSessionInfo } from "@zoltbot/protocol";
import type { FlavorRegistry } from "./flavor.js";
import { builtinRegistry } from "./flavors/index.js";
import { AcpSession } from "./session.js";
import type { AcpHost } from "./transport.js";

export * from "./definitions.js";
export * from "./flavor.js";
export * from "./flavors/index.js";
export * from "./transport.js";
export class AcpAdapter implements AgentAdapter {
  readonly id = "acp";
  private readonly writers = new NativeWriters();
  constructor(
    private readonly host: AcpHost,
    readonly flavors: FlavorRegistry = builtinRegistry(),
    private readonly timeoutMs = 30000,
  ) {}
  manifest() {
    return {
      id: this.id,
      displayName: "Agent Client Protocol",
      testedVersions: "ACP v1, SDK 2.0.2",
      binaryNames: [],
      versionCommand: ["--version"],
      staticCapabilities: { fork: false, steer: "queue_only" as const, concurrentTurns: false },
    };
  }
  probe(definition: AgentDefinition) {
    return this.host.probe(definition);
  }
  async listNativeSessions(
    _definition: AgentDefinition,
    _filter: { cwd?: string },
  ): Promise<NativeSessionInfo[]> {
    return [];
  }
  async open(definition: AgentDefinition, options: OpenOptions) {
    if (options.mode === "fork" && !options.fork) throw new Error("unsupported_fork");
    if (options.mode === "resume" && !options.nativeId) throw new Error("native_id_required");
    const registered = this.flavors.get(definition.flavor);
    const flavor = registered.newSession?.() ?? registered;
    if (options.mode === "fork" && !flavor.nativeFork) throw Error("unsupported_fork");
    const env = { ...definition.launch.env, ...options.env };
    let releaseWriter: (() => void) | undefined;
    const reserve = (nativeId: string) => {
      releaseWriter ??= this.writers.acquire(
        JSON.stringify([definition.flavor ?? definition.id, env.HOME, nativeId]),
      );
    };
    if (options.mode === "resume" && options.nativeId) reserve(options.nativeId);
    let session: AcpSession | undefined;
    try {
      const probe = await this.probe(definition);
      if (!probe.installed) throw new Error("binary_not_found");
      if (probe.broken) throw new Error("binary_broken");
      if (probe.login === "signed_out") throw new Error("auth_required");
      const transport = await this.host.connect(definition, options);
      session = new AcpSession(
        definition,
        options,
        flavor,
        transport,
        this.timeoutMs,
        reserve,
        () => releaseWriter?.(),
        probe.version,
      );
      return await session.initialize();
    } catch (error) {
      if (session) await session.close();
      else releaseWriter?.();
      throw error;
    }
  }
}
