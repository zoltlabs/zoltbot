import { expect, it } from "vitest";
import { claudeUsage, rateLimitStatus } from "./usage.js";

it("normalizes input totals to include cache reads and writes", () => {
  const samples = claudeUsage({
    usage: {
      input_tokens: 2,
      output_tokens: 3,
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 1,
    },
    modelUsage: {
      model: {
        inputTokens: 6,
        outputTokens: 9,
        cacheReadInputTokens: 24,
        cacheCreationInputTokens: 3,
      },
    },
    total_cost_usd: 0.01,
  });
  expect(samples[0]).toMatchObject({
    inputTokens: 11,
    cacheReadTokens: 8,
    cacheWriteTokens: 1,
    cumulative: false,
  });
  expect(samples[1]).toMatchObject({
    inputTokens: 33,
    outputTokens: 9,
    cacheReadTokens: 24,
    costUsd: 0.01,
    cumulative: true,
  });
});
it("rejects malformed usage counts without inventing token usage", () => {
  expect(() => claudeUsage({ usage: { input_tokens: "invalid" } })).toThrow(
    "provider_protocol_error",
  );
  expect(claudeUsage({})).toEqual([]);
});
it("reports a plan limit that blocks requests and ignores warnings and overage", () => {
  const event = (info: Record<string, unknown>) =>
    rateLimitStatus({ type: "rate_limit_event", rate_limit_info: info });
  expect(
    event({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000 }),
  ).toEqual({
    t: "status",
    state: "rate_limited",
    detail: "five_hour",
    resetsAt: "2027-01-15T08:00:00.000Z",
  });
  expect(event({ status: "allowed_warning" })).toBeUndefined();
  expect(event({ status: "rejected", overageStatus: "allowed" })).toBeUndefined();
});
