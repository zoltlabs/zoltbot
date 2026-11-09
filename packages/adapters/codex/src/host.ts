import type { OpenOptions, ProbeResult } from "@zoltbot/adapters-sdk";
import type { AgentDefinition } from "@zoltbot/protocol";
import type { CodexTransport } from "./rpc.js";
export interface CodexHost {
  /** Effective native config may contain unknown private values. Hide frames before reading it. */
  privateRead?(): void;
  connect(
    definition: AgentDefinition,
    options: Pick<OpenOptions, "cwd" | "env">,
  ): Promise<CodexTransport>;
  probe(definition: AgentDefinition): Promise<ProbeResult>;
  schema(definition: AgentDefinition): Promise<unknown>;
}
