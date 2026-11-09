import { type ApprovalOperation, matchApprovalRule } from "@zoltbot/core";
import type { ApprovalRule } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { claudeFactory } from "./claude-conformance-factory.js";

// The adapter's native rule suggestion must match the same request when the daemon builds the
// operation from the interaction context, as rule-answers.ts does.
it("suggests a Claude command rule that the approval rule engine matches", async () => {
  const ctx = await claudeFactory("approve");
  try {
    await ctx.session.send([{ type: "text", text: "suggestions" }], "queue");
    await expect.poll(() => ctx.trace.some((e) => e.t === "interaction.requested")).toBe(true);
    const event = ctx.trace.find((e) => e.t === "interaction.requested");
    if (event?.t !== "interaction.requested") throw new Error("missing_interaction");
    const context = event.interaction.context;
    const matcher = context?.ruleSuggestion;
    expect(matcher).toEqual({
      tool: "Bash",
      kind: "execute",
      command: { prefix: ["npm", "test"] },
    });
    const rule: ApprovalRule = {
      id: "rule",
      scope: "global",
      matcher: matcher as ApprovalRule["matcher"],
      decision: "allow",
      createdBy: { kind: "human", id: "owner" },
      createdAt: "2026-11-05T00:00:00.000Z",
    } as ApprovalRule;
    const operation = (command: string): ApprovalOperation => ({
      tool: context?.toolName ?? "unknown",
      agentId: event.interaction.agentId,
      ...(context?.toolKind ? { kind: context.toolKind } : {}),
      command,
      kind: "execute",
    });
    const at = "2026-11-05T01:00:00.000Z";
    expect(matchApprovalRule(rule, operation(context?.command ?? ""), at)).toBe(true);
    expect(matchApprovalRule(rule, operation("npm test -- --coverage"), at)).toBe(true);
    expect(matchApprovalRule(rule, operation("npm run build"), at)).toBe(false);
    await ctx.session.respond(event.interaction.id, {
      action: "decline",
      by: { kind: "human", id: "owner" },
      at,
    });
  } finally {
    await ctx.dispose();
  }
});
