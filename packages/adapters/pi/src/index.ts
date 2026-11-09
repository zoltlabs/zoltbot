import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AgentAdapter, NativeWriters, type OpenOptions } from "@zoltbot/adapters-sdk";
import type { AgentDefinition, NativeSessionInfo } from "@zoltbot/protocol";
import type { PiFile, PiHost } from "./host.js";
import { piLaunch } from "./launch.js";
import { PiPeer } from "./peer.js";
import { PiSession } from "./session.js";

export * from "./definitions.js";
export * from "./host.js";
export * from "./openrouter.js";
export class PiAdapter implements AgentAdapter {
  readonly id = "pi";
  private readonly writers = new NativeWriters();
  constructor(
    private readonly host: PiHost,
    private readonly timeoutMs = 30000,
  ) {}
  manifest() {
    return {
      id: this.id,
      displayName: "Pi",
      testedVersions: "1.4.0",
      binaryNames: ["pi"],
      versionCommand: ["--version"],
      staticCapabilities: {
        resume: true,
        fork: true,
        steer: "native" as const,
        concurrentTurns: false,
      },
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
    if (options.mode !== "new" && !options.nativeId && !options.fork?.sourceNativeId)
      throw new Error("native_id_required");
    const nativeId =
      options.mode === "resume"
        ? (options.nativeId as string)
        : (options.fork?.targetNativeId ?? randomUUID());
    const env = { ...definition.launch.env, ...options.env };
    const release = this.writers.acquire(
      JSON.stringify([this.id, env.PI_CODING_AGENT_DIR ?? env.HOME, nativeId]),
    );
    const files: PiFile[] = [];
    let session: PiSession | undefined;
    let peer: PiPeer | undefined;
    try {
      const probe = await this.probe(definition);
      if (!probe.installed) throw new Error("binary_not_found");
      if (probe.broken) throw new Error("binary_broken");
      if (probe.login === "signed_out") throw new Error("auth_required");
      const source = readFileSync(new URL("./extension.ts", import.meta.url), "utf8"),
        hash = createHash("sha256").update(source).digest("hex");
      const extension = await this.host.extension(source, hash);
      files.push(extension);
      if (createHash("sha256").update(readFileSync(extension.path)).digest("hex") !== hash)
        throw new Error("extension_hash_mismatch");
      const nonce = randomUUID();
      const config = await this.host.config({
        profile: options.permissionProfile,
        cwd: options.cwd,
        hostMcp: options.hostMcp,
        nonce,
      });
      files.push(config);
      const launch = piLaunch(
        definition,
        options,
        { extension: extension.path, config: config.path },
        nativeId,
      );
      peer = new PiPeer(await this.host.connect(definition, options, launch), this.timeoutMs);
      session = new PiSession(
        peer,
        nativeId,
        options,
        files,
        release,
        this.timeoutMs,
        definition.flavor,
      );
      await session.ready(nonce, extension.path, probe.version ?? "unknown");
      return session;
    } catch (error) {
      if (session) await session.close();
      else {
        await peer?.close();
        for (const file of files) await file.dispose();
        release();
      }
      throw error;
    }
  }
}
