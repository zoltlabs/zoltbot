import type { ActorRef, InteractionAnswer, UserInput } from "@zoltbot/protocol";
import type { Changes } from "../../../gitkit/src/index.js";
import type { RuntimeObservation } from "../runtime-observer.js";

export interface RunnerSession {
  threadId: string;
}
export interface RunnerTurn extends RunnerSession {
  commandId: string;
  input: UserInput;
  mode: "queue" | "steer";
}
export interface RunnerAnswer {
  id: string;
  version: number;
  answer: InteractionAnswer;
  commandId: string;
  actor?: ActorRef;
}
export interface Runner {
  prepareWorkspace(input: RunnerSession): Promise<void>;
  startSession(input: RunnerSession): Promise<void>;
  sendTurn(input: RunnerTurn): Promise<unknown>;
  answerInteraction(input: RunnerAnswer): Promise<unknown>;
  interrupt(input: RunnerSession & { turnId: string; commandId: string }): Promise<unknown>;
  stop(input: RunnerSession): Promise<void>;
  collectResult(input: { cwd: string; baseRef: string }): Promise<Changes>;
  events(): AsyncIterable<RuntimeObservation>;
  close(): Promise<void>;
}
