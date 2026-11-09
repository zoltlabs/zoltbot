import {
  ApprovalRuleSchema,
  type Interaction,
  InteractionSchema,
  parse,
  parseEvent,
} from "@zoltbot/protocol";
import { type ApprovalOperation, decideApproval } from "./approval-rules.js";
import { type CommandContext, handle, type Outcome } from "./commands.js";
import type { DomainState } from "./projectors.js";

/** Use current durable rules for every request so revocation takes effect immediately. */
export function applyRuleAnswer(
  state: DomainState,
  id: string,
  context: CommandContext,
  verifiedPaths?: readonly string[],
): Outcome {
  if (context.actor.kind !== "system") throw new Error("system_rule_answer_required");
  const unmatched = { events: [], result: { matched: false } };
  const row = state.interaction?.find((value) => value.id === id);
  if (!row || row.state !== "pending" || row.type !== "approval") return unmatched;
  const request = parse(InteractionSchema, row);
  if (request.items.some((item) => item.secret)) return unmatched;
  const thread = state.thread?.find((value) => value.id === request.threadId);
  if (!thread || thread.agentId !== request.agentId || thread.archived) return unmatched;
  const pathsVerified =
    !!verifiedPaths?.length && request.context?.paths?.length === verifiedPaths.length;
  const operation: ApprovalOperation = {
    tool: request.context?.toolName ?? (request.context?.command ? "execute" : "unknown"),
    agentId: request.agentId,
    ...(request.context?.toolKind ? { kind: request.context.toolKind } : {}),
    ...(typeof thread.projectId === "string" ? { projectId: thread.projectId } : {}),
    ...(request.context?.command ? { command: request.context.command, kind: "execute" } : {}),
    ...(request.context?.paths
      ? { paths: pathsVerified ? [...verifiedPaths] : request.context.paths, pathsVerified }
      : {}),
    ...(request.context?.network ? { host: request.context.network.host, kind: "fetch" } : {}),
  };
  const rules = (state.rule ?? []).map((value) => parse(ApprovalRuleSchema, value));
  const rule = decideApproval(rules, operation, context.at);
  if (!rule) return unmatched;
  if (
    rule.decision === "allow" &&
    !request.items.some((item) => item.choices?.some((choice) => choice.id === "allow_once"))
  )
    return unmatched;
  const outcome = handle(
    state,
    {
      type: "answer",
      id,
      version: request.version,
      answer: {
        action: rule.decision === "allow" ? "accept" : "decline",
        ...(rule.decision === "allow" ? { choice: "allow_once" } : {}),
        by: context.actor,
        at: context.at,
        automatic: true,
      },
    },
    context,
  );
  const events = outcome.events.map((event) =>
    event.aggregateType !== "audit"
      ? event
      : parseEvent({
          ...event,
          payload: {
            ...(event.payload as Record<string, unknown>),
            detail: { confirmed: false, ruleId: rule.id },
          },
        }),
  );
  return {
    events,
    result: { matched: true, ruleId: rule.id, interaction: outcome.result as Interaction },
  };
}
