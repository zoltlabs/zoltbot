import { type AgentSession, AsyncQueue } from "@zoltbot/adapters-sdk";
import type { AgentEvent, UserInput } from "@zoltbot/protocol";
import { referenceCapabilities } from "./capabilities.js";

/** Deterministic independent columns, including a slow column and a mid-turn failure. */
export class CompareFakeSession implements AgentSession {
  readonly capabilities = referenceCapabilities;
  readonly received: UserInput[] = [];
  readonly firstTokens: number[] = [];
  readonly eventsQueue = new AsyncQueue<AgentEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private turn = "";
  readonly replies: unknown[] = [];
  interrupted = 0;
  private finish: (() => void) | undefined;
  constructor(
    readonly nativeId: string,
    readonly delayMs: number,
    readonly fail = false,
    readonly question?: { threadId: string; profileId: string },
    readonly answer = `${nativeId} answer`,
  ) {
    void this.eventsQueue.push({
      t: "session.ready",
      nativeId,
      capabilities: this.capabilities,
      providerVersion: "compare-fake-1",
    });
  }
  events() {
    return this.eventsQueue;
  }
  async send(input: UserInput) {
    this.received.push(structuredClone(input));
    const delay = input.some((part) => part.type === "text" && part.text.includes("Take time"))
      ? 3000
      : this.delayMs;
    const start = performance.now(),
      turnId = `${this.nativeId}-${this.received.length}`;
    this.turn = turnId;
    await this.eventsQueue.push({ t: "turn.started", turnId });
    this.timer = setTimeout(() => {
      this.firstTokens.push(performance.now() - start);
      void this.eventsQueue.push({
        t: "text.delta",
        turnId,
        itemId: `${turnId}-answer`,
        text: this.answer,
      });
      const finish = () => {
        if (!this.fail)
          void this.eventsQueue.push({
            t: "message.done",
            turnId,
            itemId: `${turnId}-answer`,
            text: this.answer,
            phase: "final",
          });
        void this.eventsQueue.push({
          t: "usage.updated",
          turnId,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        });
        void this.eventsQueue.push({
          t: "turn.done",
          turnId,
          status: this.fail ? "failed" : "completed",
        });
      };
      this.timer = setTimeout(() => {
        if (
          this.question &&
          input.some((part) => part.type === "text" && part.text.includes("question"))
        ) {
          this.finish = finish;
          void this.eventsQueue.push({
            t: "interaction.requested",
            interaction: {
              id: `question:${turnId}`,
              agentId: this.question.profileId,
              threadId: this.question.threadId,
              turnId,
              type: "question",
              items: [
                {
                  id: "q",
                  prompt: "Choose an approach",
                  options: [{ id: "yes", label: "Use this approach" }],
                },
              ],
              chain: [],
              urgency: "blocking",
            },
          });
        } else finish();
      }, delay);
    }, delay);
    return { disposition: "started" as const, id: turnId };
  }
  async interrupt() {
    this.interrupted++;
    clearTimeout(this.timer);
    await this.eventsQueue.push({ t: "turn.done", turnId: this.turn, status: "interrupted" });
  }
  async respond(...args: unknown[]) {
    this.replies.push(args);
    this.finish?.();
    this.finish = undefined;
  }
  async setModel() {}
  async setMode() {}
  async compact() {}
  async rename() {}
  async contextUsage() {
    return undefined;
  }
  async close() {
    clearTimeout(this.timer);
    this.eventsQueue.close();
  }
}
