import { setBudget } from "@zoltbot/core/budgets";
import { summarizeUsage } from "@zoltbot/core/usage-meter";
import { type DomainEvent, parse, UsageRecordSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

export function usageApi(host: { store: Store; publish(events: DomainEvent[]): void }) {
  return (method: string, params: Record<string, unknown>, commandId?: string): unknown => {
    if (!["usage.query", "overhead.get", "budget.set"].includes(method)) return undefined;
    if (method === "budget.set") {
      if (!commandId) throw new Error("command_id_required");
      let produced = false;
      const before = host.store.lastSeq();
      const receipt = host.store.dispatch(commandId, (state) => {
        produced = true;
        return setBudget(
          state,
          {
            scopeType: String(params.scopeType),
            scopeId: String(params.scopeId),
            ...(params.usd !== undefined ? { usd: params.usd as number } : {}),
            ...(params.tokens !== undefined ? { tokens: params.tokens as number } : {}),
            confirmed: params.confirmed === true,
          },
          { commandId, at: new Date().toISOString(), actor: { kind: "human", id: "local-owner" } },
        );
      });
      if (receipt.result.ok !== true) throw new Error("command_receipt_conflict");
      if (produced) host.publish(host.store.eventsSince(before));
      return { ok: true };
    }
    const rows = (host.store.snapshot().usage ?? []).map((value) =>
      parse(UsageRecordSchema, value),
    );
    if (method === "overhead.get") {
      const summary = summarizeUsage(rows.filter((row) => row.sessionId === params.sessionId));
      return {
        injectedTokens: summary.injectedTokens,
        ...(summary.inputTokens !== undefined ? { inputTokens: summary.inputTokens } : {}),
        ...(summary.cacheRatio !== undefined ? { cacheRatio: summary.cacheRatio } : {}),
      };
    }
    const from = params.from === undefined ? -Infinity : Date.parse(String(params.from));
    const to = params.to === undefined ? Infinity : Date.parse(String(params.to));
    if (Number.isNaN(from) || Number.isNaN(to) || from >= to)
      throw new Error("invalid_usage_range");
    const selected = rows
      .filter(
        (row) =>
          (!params.taskId || row.taskId === params.taskId) &&
          (!params.projectId || row.projectId === params.projectId) &&
          Date.parse(row.recordedAt) >= from &&
          Date.parse(row.recordedAt) < to,
      )
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
    if (selected.length > 10000) throw new Error("usage_range_too_large");
    return selected;
  };
}
