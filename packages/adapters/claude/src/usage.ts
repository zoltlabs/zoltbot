import type { AgentEvent, UsageSample } from "@zoltbot/protocol";
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("provider_protocol_error");
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("provider_protocol_error");
  return value;
}
const count = (value: unknown) => {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error("provider_protocol_error");
  return value;
};
export function claudeUsage(result: Record<string, unknown>): UsageSample[] {
  const samples: UsageSample[] = [];
  if (result.usage) {
    const value = record(result.usage),
      read = count(value.cache_read_input_tokens),
      write = count(value.cache_creation_input_tokens);
    samples.push({
      inputTokens: count(value.input_tokens) + read + write,
      outputTokens: count(value.output_tokens),
      cacheReadTokens: read,
      cacheWriteTokens: write,
      cumulative: false,
    });
  }
  if (result.modelUsage) {
    let inputTokens = 0,
      outputTokens = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0;
    for (const entry of Object.values(record(result.modelUsage))) {
      const value = record(entry),
        read = count(value.cacheReadInputTokens),
        write = count(value.cacheCreationInputTokens);
      inputTokens += count(value.inputTokens) + read + write;
      outputTokens += count(value.outputTokens);
      cacheReadTokens += read;
      cacheWriteTokens += write;
    }
    const cost = result.total_cost_usd;
    samples.push({
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
      cumulative: true,
    });
  }
  return samples;
}
/**
 * A rate_limit_event becomes rate_limited only when the plan limit blocks requests and overage
 * does not cover them. resetsAt is Unix seconds.
 */
export function rateLimitStatus(frame: Record<string, unknown>): AgentEvent | undefined {
  const info = frame.rate_limit_info;
  if (!info || typeof info !== "object") return undefined;
  const value = info as Record<string, unknown>;
  const overage =
    value.overageStatus === "allowed" ||
    value.overageStatus === "allowed_warning" ||
    value.isUsingOverage === true ||
    value.overageInUse === true;
  if (value.status !== "rejected" || overage) return undefined;
  const reset = typeof value.resetsAt === "number" ? value.resetsAt * 1000 : Number.NaN;
  return {
    t: "status",
    state: "rate_limited",
    ...(typeof value.rateLimitType === "string" ? { detail: value.rateLimitType } : {}),
    ...(Number.isFinite(reset) && reset > 0 && reset < 8.64e15
      ? { resetsAt: new Date(reset).toISOString() }
      : {}),
  };
}
