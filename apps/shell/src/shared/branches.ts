// Branching a chat from one of its messages (S3): what the renderer asks main and gets back.

/** Where the branch starts: before the owner's message in a turn, or after the turn's answer. */
export type BranchPoint = "before_user" | "after_turn";

export interface BranchInput {
  botId: string;
  turnId: string;
  at: BranchPoint;
}

/** How the branch would be made, from the daemon's fork preview. */
export interface BranchPreview {
  available: boolean;
  /** "native" keeps the agent's own conversation state; "copied" resends earlier messages. */
  kind: "native" | "copied";
  copiedMessages: number;
  omittedMessages: number;
  /** Why it can't branch, when `available` is false. */
  reason: string;
}

export interface BranchRequest extends BranchInput {
  title: string;
  /** Reused when the owner retries, so a retry never makes a second branch. */
  attemptId: string;
}

export interface BranchResult {
  botId: string;
  /** False while the daemon hasn't confirmed the new chat; retry with the same attempt id. */
  ready: boolean;
  /** The branch can't finish; a retry needs a new attempt id. */
  failed: boolean;
}

/** Where a branched chat came from: the source chat and the turn the branch starts at. */
export interface BranchOrigin {
  botId: string;
  turnId: string;
  at: BranchPoint;
}
