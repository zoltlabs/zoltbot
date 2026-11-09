import { type AgentSession, AsyncQueue } from "@zoltbot/adapters-sdk";
import type { AgentEvent, UserInput } from "@zoltbot/protocol";
import { referenceCapabilities } from "./capabilities.js";
export class ForkFakeSession implements AgentSession {
  readonly capabilities = {
    ...referenceCapabilities,
    nativeFork: {
      latest: true,
      boundaries: ["before_user", "after_turn"] as ("before_user" | "after_turn")[],
      callerId: true,
      activation: "active" as const,
    },
  };
  readonly queue = new AsyncQueue<AgentEvent>();
  readonly received: UserInput[] = [];
  constructor(readonly nativeId: string) {
    void this.queue.push({
      t: "session.ready",
      nativeId,
      capabilities: this.capabilities,
      providerVersion: "fork-fixture-1",
    });
  }
  events() {
    return this.queue;
  }
  async send(input: UserInput) {
    this.received.push(input);
    const turnId = `${this.nativeId}:${this.received.length}`;
    await this.queue.push({ t: "turn.started", turnId });
    await this.queue.push({ t: "turn.done", turnId, status: "completed" });
    return { disposition: "started" as const };
  }
  async interrupt() {}
  async respond() {}
  async setModel() {}
  async setMode() {}
  async compact() {}
  async rename() {}
  async contextUsage() {
    return undefined;
  }
  async close() {
    this.queue.close();
  }
}
