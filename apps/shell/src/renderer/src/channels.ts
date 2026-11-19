import type {
  ChannelDetail,
  ChannelMember,
  ChannelPostView,
  ChannelRequestActionName,
  ChannelRequestState,
  ChannelRequestView,
} from "../../shared/channels";

export const REQUEST_STATE_LABELS: Record<ChannelRequestState, string> = {
  open: "Open",
  running: "Running",
  done: "Done",
  stopped: "Stopped",
  archived: "Archived",
};

/** Actions the request panel offers in each state; the bar offers Reassign, Stop and Resume. */
export const PANEL_ACTIONS: Record<ChannelRequestState, ChannelRequestActionName[]> = {
  open: ["archive"],
  running: ["archive"],
  stopped: ["resume", "archive"],
  done: ["archive"],
  archived: ["restore"],
};

const TASK_LINES: Record<string, { tone: string; label: string }> = {
  queued: { tone: "queued", label: "Queued" },
  running: { tone: "running", label: "Running" },
  blocked: { tone: "waiting", label: "Blocked" },
  review: { tone: "review", label: "Ready for review" },
  completed: { tone: "done", label: "Accepted" },
  failed: { tone: "failed", label: "Failed" },
  cancelled: { tone: "queued", label: "Stopped" },
};

/** The dot tone and label for a task line in the transcript. */
export function taskLine(state: string): { tone: string; label: string } {
  return TASK_LINES[state] ?? { tone: "queued", label: "Queued" };
}

/** Tasks a Stop would cancel. */
export function openTasks(request: ChannelRequestView) {
  return request.tasks.filter((task) =>
    ["queued", "running", "blocked", "review"].includes(task.state),
  );
}

/** The state an action leaves a request in, shown before the daemon answers. */
export function stateAfter(
  request: ChannelRequestView,
  action: ChannelRequestActionName,
): ChannelRequestState {
  if (action === "stop") return "stopped";
  if (action === "archive") return "archived";
  if (action === "resume") return "open";
  // Restore returns the request to where it was; the daemon's answer settles it.
  if (action === "restore") return "open";
  return request.state;
}

/** The @mention being typed just before the caret, if any. */
export function mentionAt(
  value: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|\s)@([^\s@]{0,40})$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  return { query, start: caret - query.length - 1, end: caret };
}

/** Members whose name starts with the query, lead first. */
export function matchMembers(members: readonly ChannelMember[], query: string): ChannelMember[] {
  const q = query.toLocaleLowerCase();
  return members
    .filter((member) => member.name.toLocaleLowerCase().startsWith(q))
    .sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name));
}

/** Replaces the typed mention with the member's name and returns the new text and caret. */
export function insertMention(
  value: string,
  mention: { start: number; end: number },
  member: ChannelMember,
): { value: string; caret: number } {
  const inserted = `@${member.name} `;
  return {
    value: value.slice(0, mention.start) + inserted + value.slice(mention.end),
    caret: mention.start + inserted.length,
  };
}

/** Chats the text @mentions by name, so the post reaches exactly the people it names. */
export function mentionedMembers(value: string, members: readonly ChannelMember[]): string[] {
  const found: string[] = [];
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  let rest = value;
  for (const member of sorted) {
    const escaped = member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])@${escaped}(?![\\p{L}\\p{N}_])`, "giu");
    if (pattern.test(rest)) {
      found.push(member.threadId);
      rest = rest.replace(pattern, "$1");
    }
  }
  return found;
}

/** Who a new post will reach: the people it names, else the lead. */
export function recipientsFor(value: string, detail: ChannelDetail): ChannelMember[] {
  const named = mentionedMembers(value, detail.members);
  if (named.length) return detail.members.filter((member) => named.includes(member.threadId));
  return detail.members.filter((member) => member.lead);
}

/** A post shown at once, before the daemon has stored it. */
export function optimisticPost(
  postId: string,
  value: string,
  detail: ChannelDetail,
  at: string,
): ChannelPostView {
  return {
    id: postId,
    author: { kind: "owner" },
    text: value,
    to: recipientsFor(value, detail).map((member) => member.name),
    requestId: `request-${postId}`,
    question: false,
    createdAt: at,
  };
}

/** The request the bar shows: the newest one still open or running, else the newest stopped one. */
export function currentRequest(requests: readonly ChannelRequestView[]) {
  const newest = [...requests].reverse();
  return (
    newest.find((request) => request.state === "open" || request.state === "running") ??
    newest.find((request) => request.state === "stopped") ??
    null
  );
}

export function shortTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
