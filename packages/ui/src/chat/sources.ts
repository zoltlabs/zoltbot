import { terms } from "@zoltbot/protocol";
import { threadName } from "../workspaces/manager-view.js";
import { object } from "../workspaces/view.js";
import type { Row } from "./types.js";
import { text } from "./types.js";

/** Label for an agent-originated input whose source message is not known. */
export const unknownSource = "Agent message";
/** Who sent an agent-originated input, and the chat to open when it is known. */
export interface MessageSource {
  label: string;
  threadId?: string;
}

/**
 * Labels for agent-originated inputs, keyed by the source message id. Built once per snapshot
 * so each timeline row is a map lookup. A delegation reads as coming from its manager; a report
 * or a teammate's message reads as coming from the chat that sent it.
 */
export function messageSources(audits: Row[], threads: Row[], profiles: Row[]) {
  const byId = new Map(threads.map((row) => [text(row.id), row]));
  const name = (id: string) => threadName(byId.get(id), profiles);
  const result = new Map<string, MessageSource>();
  const from = (label: string, threadId: string) =>
    byId.has(threadId) ? { label, threadId } : { label };
  for (const row of audits) {
    const detail = object(row.detail);
    if (row.action === "manager.delegate") {
      // Delegations recorded before messageId was audited use the brief's fixed id.
      const id =
        text(detail.messageId) ||
        (text(row.id).endsWith(":delegation") && text(row.target)
          ? `${text(row.target)}:brief`
          : "");
      const manager = text(detail.managerThreadId);
      if (id)
        result.set(
          id,
          byId.has(manager)
            ? from(`From ${name(manager)} (${terms.manager.one})`, manager)
            : { label: `From a ${terms.manager.one}` },
        );
    } else if (row.action === "team.report") {
      const id = text(detail.messageId),
        sender = text(detail.fromThreadId);
      if (id) result.set(id, from(`Report from ${name(sender)}`, sender));
    } else if (row.action === "team.message") {
      const id = text(detail.messageId),
        sender = text(detail.fromThreadId);
      const what = detail.replyTo ? "Reply" : detail.kind === "question" ? "Question" : "Update";
      if (id) result.set(id, from(`${what} from ${name(sender)}`, sender));
    }
  }
  return result;
}
