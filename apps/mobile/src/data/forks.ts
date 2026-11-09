import { text } from "@zoltbot/ui/chat/types";
import type { Row, Snapshot } from "./transport.js";

// Where a forked chat came from, and the edited copies of a message (desktop ForkControl and
// EditDialog). Only the thread's own fork provenance is read.

export interface ForkInfo {
  sourceThreadId: string;
  sourceTitle: string;
  kind: "native" | "copied";
  copiedMessages?: number;
  omittedMessages?: number;
  /** For an edit (a fork from before a message): this chat among the original and its edits. */
  versions?: { ids: string[]; index: number };
}

const provenance = (thread: Row | undefined) =>
  thread?.fork && typeof thread.fork === "object" ? (thread.fork as Row) : undefined;
const boundaryTurn = (fork: Row) => {
  const boundary = (fork.boundary ?? {}) as Row;
  return boundary.kind === "before_user" ? text(boundary.turnId) : "";
};

/** Edits of one message in `sourceId`, oldest first, after the original. */
function versionsOf(snapshot: Snapshot, sourceId: string, turnId: string): string[] {
  const edits = (snapshot.entities.thread ?? [])
    .filter((thread) => {
      const fork = provenance(thread);
      return (
        thread.archived !== true &&
        fork &&
        fork.sourceThreadId === sourceId &&
        boundaryTurn(fork) === turnId
      );
    })
    .sort((a, b) => text(a.createdAt).localeCompare(text(b.createdAt)))
    .map((thread) => text(thread.id));
  return [sourceId, ...edits];
}

export function forkInfo(snapshot: Snapshot, threadId: string): ForkInfo | undefined {
  const threads = snapshot.entities.thread ?? [];
  const fork = provenance(threads.find((row) => row.id === threadId));
  if (!fork) return undefined;
  const sourceThreadId = text(fork.sourceThreadId);
  const turnId = boundaryTurn(fork);
  const ids = turnId ? versionsOf(snapshot, sourceThreadId, turnId) : [];
  return {
    sourceThreadId,
    sourceTitle: text(threads.find((row) => row.id === sourceThreadId)?.title) || "the original",
    kind: fork.kind === "copied" ? "copied" : "native",
    ...(typeof fork.copiedMessages === "number" ? { copiedMessages: fork.copiedMessages } : {}),
    ...(typeof fork.omittedMessages === "number" ? { omittedMessages: fork.omittedMessages } : {}),
    ...(ids.length > 1 ? { versions: { ids, index: ids.indexOf(threadId) } } : {}),
  };
}

/** For each message in this chat that was edited into new chats: those chats, newest first. */
export function editsOf(snapshot: Snapshot, threadId: string): Map<string, string[]> {
  const turns = new Set<string>();
  for (const thread of snapshot.entities.thread ?? []) {
    const fork = provenance(thread);
    if (fork && thread.archived !== true && fork.sourceThreadId === threadId)
      turns.add(boundaryTurn(fork));
  }
  turns.delete("");
  return new Map(
    [...turns].map((turnId) => [turnId, versionsOf(snapshot, threadId, turnId).slice(1).reverse()]),
  );
}

const forkReasons: Record<string, string> = {
  copied_history_unavailable: "There is no text history to copy, or the last message is too long.",
  fork_history_limit: "This chat is too long to copy. Start a new chat instead.",
  fork_destination_unavailable: "Choose an available agent.",
  native_fork_unverified: "A native fork needs the same agent. Choose Automatic or Copy.",
  fork_requires_idle: "Stop the current work and answer what it asked first.",
  fork_history_unavailable: "This chat has no saved history yet.",
  fork_configuration_unavailable: "The chat's original setup is no longer available.",
  fork_execution_context_unavailable: "This chat's browser or artifact state cannot be copied yet.",
};
/** Why a fork is not possible, in words; falls back to a generic line. */
export function forkReason(reason: unknown): string {
  return forkReasons[text(reason)] ?? "This chat cannot be forked to that agent right now.";
}
