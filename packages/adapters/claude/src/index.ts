import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { type AgentAdapter, NativeWriters, type OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, NativeSessionInfo } from "@zoltbot/protocol";
import type { ClaudeHost } from "./host.js";
import { listClaudeSessions } from "./native-sessions.js";
import { ClaudeSession } from "./session.js";

export * from "./host.js";
export class ClaudeAdapter implements AgentAdapter {
  readonly id = "claude";
  private readonly writers = new NativeWriters();
  constructor(
    private readonly host: ClaudeHost,
    private readonly timeoutMs = 30000,
    private readonly idleMs = 600000,
  ) {}
  manifest() {
    return {
      id: this.id,
      displayName: "Claude Code",
      testedVersions: "2.1.299",
      binaryNames: ["claude"],
      versionCommand: ["--version"],
      supportsConnections: true,
      supportsLocalBrowserCli: true,
      supportsNativeSkills: true,
      staticCapabilities: {
        resume: true,
        fork: true,
        steer: "native" as const,
        concurrentTurns: false,
      },
    };
  }
  nativeSkillLayout(skill: { name: string; revision: number; hash: string }) {
    const namespace = `zoltbot-${skill.hash.slice(0, 12)}`;
    return {
      prefix: `skills/${skill.name}`,
      namespace,
      files: [
        {
          path: ".claude-plugin/plugin.json",
          content: JSON.stringify({ name: namespace, version: `1.0.${skill.revision}` }),
        },
      ],
    };
  }
  probe(definition: AgentDefinition) {
    return this.host.probe(definition);
  }
  async listNativeSessions(
    definition: AgentDefinition,
    filter: { cwd?: string },
  ): Promise<NativeSessionInfo[]> {
    if (filter.cwd !== undefined) throw new Error("native_cwd_filter_unverified");
    const root =
      definition.launch.env.CLAUDE_CONFIG_DIR ??
      path.join(definition.launch.env.HOME ?? homedir(), ".claude");
    return listClaudeSessions(root);
  }
  async open(definition: AgentDefinition, options: OpenOptions) {
    if (options.mode !== "new" && !options.nativeId && !options.fork?.sourceNativeId)
      throw new Error("native_id_required");
    const nativeId =
      options.mode === "resume"
        ? (options.nativeId as string)
        : (options.fork?.targetNativeId ?? randomUUID());
    const release = this.writers.acquire(
      JSON.stringify([
        this.id,
        options.env?.CLAUDE_CONFIG_DIR ?? definition.launch.env.CLAUDE_CONFIG_DIR,
        nativeId,
      ]),
    );
    let session: ClaudeSession | undefined;
    try {
      const probe = await this.probe(definition);
      if (!probe.installed) throw new Error("binary_not_found");
      if (probe.broken) throw new Error("binary_broken");
      if (probe.login === "signed_out") throw new Error("auth_required");
      if (options.mode === "fork" && options.fork && probe.version !== "2.1.319")
        throw new Error("native_fork_unverified");
      session = new ClaudeSession(
        this.host,
        definition,
        { ...options },
        nativeId,
        release,
        this.timeoutMs,
        this.idleMs,
      );
      await session.ready();
      return session;
    } catch (error) {
      if (session) await session.close();
      else release();
      throw error;
    }
  }
}
