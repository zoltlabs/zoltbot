import type {
  BranchInput,
  BranchPoint,
  BranchPreview,
  BranchRequest,
  BranchResult,
} from "../shared/branches";
import { IPC_CHANNELS } from "../shared/ipc";
import type { DaemonClient } from "./daemon-client";
import { text } from "./mapping";
import { requireString } from "./parsers";

type Row = Record<string, unknown>;

function parsePoint(value: unknown): BranchPoint {
  if (value === "before_user" || value === "after_turn") return value;
  throw new Error("Choose where the branch starts.");
}

export function parseBranchInput(input: unknown): BranchInput {
  const row = (input ?? {}) as Row;
  return {
    botId: requireString(row.botId, "botId"),
    turnId: requireString(row.turnId, "turnId"),
    at: parsePoint(row.at),
  };
}

export function parseBranchRequest(input: unknown): BranchRequest {
  const row = (input ?? {}) as Row;
  return {
    ...parseBranchInput(input),
    title: requireString(row.title, "title").slice(0, 200),
    attemptId: requireString(row.attemptId, "attemptId"),
  };
}

function boundary(input: BranchInput) {
  return { kind: input.at, turnId: input.turnId };
}

export function branchService(client: DaemonClient) {
  return {
    async preview(input: BranchInput): Promise<BranchPreview> {
      const row = ((await client.call("thread.forkPreview", {
        id: input.botId,
        boundary: boundary(input),
      })) ?? {}) as Row;
      return {
        available: row.available === true,
        kind: row.kind === "copied" ? "copied" : "native",
        copiedMessages: Number(row.copiedMessages) || 0,
        omittedMessages: Number(row.omittedMessages) || 0,
        reason: text(row.reason),
      };
    },
    async branch(request: BranchRequest): Promise<BranchResult> {
      const operation = ((await client.call(
        "thread.fork",
        { id: request.botId, title: request.title, boundary: boundary(request) },
        request.attemptId,
      )) ?? {}) as Row;
      const state = text(operation.state);
      return {
        botId: text(operation.childThreadId),
        ready: state === "ready",
        failed: state === "failed" || state === "needs_reconciliation",
      };
    },
  };
}

/** The renderer's branch calls. */
export function branchHandlers(client: DaemonClient): Record<string, (input: unknown) => unknown> {
  const service = branchService(client);
  return {
    [IPC_CHANNELS.agentBranchPreview]: (input) => service.preview(parseBranchInput(input)),
    [IPC_CHANNELS.agentBranch]: (input) => service.branch(parseBranchRequest(input)),
  };
}
