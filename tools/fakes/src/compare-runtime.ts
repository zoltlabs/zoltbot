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
  /** True from turn.started until turn.done; a steered message joins the running turn. */
  private running = false;
  /** Context tokens in use; a message about a long context fills it to 85%. Zero reports none. */
  private contextUsed = 0;
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
  async send(input: UserInput, mode: "queue" | "steer" = "queue") {
    this.received.push(structuredClone(input));
    if (mode === "steer" && this.running) return { disposition: "handled" as const, id: this.turn };
    const delay = input.some((part) => part.type === "text" && part.text.includes("Take time"))
      ? 3000
      : this.delayMs;
    const start = performance.now(),
      turnId = `${this.nativeId}-${this.received.length}`;
    this.turn = turnId;
    this.running = true;
    await this.eventsQueue.push({ t: "turn.started", turnId });
    // "long context" fills 85% of the window, "very long context" 95%.
    const said = (pattern: RegExp) =>
      input.some((part) => part.type === "text" && pattern.test(part.text));
    if (said(/very long context/i)) this.contextUsed = 95_000;
    else if (said(/long context/i)) this.contextUsed = 85_000;
    else if (this.contextUsed) this.contextUsed += 2_000;
    // A message that asks for a checklist gets a plan: three steps, the last finishing with the turn.
    const plan = input.some((part) => part.type === "text" && /\bchecklist\b/i.test(part.text));
    const steps = ["Read the notes", "Draft the summary", "Check the links"];
    const planned = (done: number) =>
      this.eventsQueue.push({
        t: "plan.updated",
        turnId,
        entries: steps.map((step, index) => ({
          step,
          status:
            index < done
              ? ("completed" as const)
              : index === done
                ? ("in_progress" as const)
                : ("pending" as const),
        })),
      });
    if (plan) await planned(2);
    this.timer = setTimeout(() => {
      this.firstTokens.push(performance.now() - start);
      void this.eventsQueue.push({
        t: "text.delta",
        turnId,
        itemId: `${turnId}-answer`,
        text: this.answer,
      });
      const finish = () => {
        if (plan && !this.fail) void planned(steps.length);
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
        this.running = false;
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
    this.running = false;
    await this.eventsQueue.push({ t: "turn.done", turnId: this.turn, status: "interrupted" });
  }
  async respond(...args: unknown[]) {
    this.replies.push(args);
    this.finish?.();
    this.finish = undefined;
  }
  async setModel() {}
  async setMode() {}
  async compact() {
    const before = this.contextUsed;
    if (before) this.contextUsed = 12_000;
    await this.eventsQueue.push({ t: "compaction", state: "started", trigger: "manual" });
    await this.eventsQueue.push({
      t: "compaction",
      state: "done",
      trigger: "manual",
      ...(before ? { tokensBefore: before, tokensAfter: this.contextUsed } : {}),
    });
  }
  async rename() {}
  async contextUsage() {
    return this.contextUsed ? { used: this.contextUsed, size: 100_000 } : undefined;
  }
  async close() {
    clearTimeout(this.timer);
    this.eventsQueue.close();
  }
}
