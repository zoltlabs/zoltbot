import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import { openStore } from "@zoltbot/store";
import { expect, it } from "vitest";
import { usageApi } from "./usage-api.js";

async function fixture() {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/usage-"));
  const store = await openStore(path.join(root, "store.db"));
  const api = usageApi({ store, publish() {} });
  return {
    store,
    api,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it("queries a half open time range and reads overhead without inventing missing metrics", async () => {
  const test = await fixture();
  try {
    const at = "2026-10-28T12:00:00Z";
    for (const [id, sessionId, recordedAt] of [
      ["a", "session", at],
      ["b", "other", "2026-10-28T13:00:00Z"],
    ])
      test.store.dispatch(id as string, (state) =>
        handle(
          state,
          {
            type: "create",
            kind: "usage",
            value: {
              id,
              sessionId,
              recordedAt,
              projectId: "project",
              inputTokens: 100,
              cacheReadTokens: 80,
              injectedTokens: 20,
              costKnown: false,
            },
          },
          { commandId: id as string, at, actor: { kind: "system", id: "runtime" } },
        ),
      );
    expect(
      test.api("usage.query", { projectId: "project", from: at, to: "2026-10-28T13:00:00Z" }),
    ).toMatchObject([{ id: "a", costKnown: false }]);
    expect(test.api("overhead.get", { sessionId: "session" })).toEqual({
      injectedTokens: 20,
      inputTokens: 100,
      cacheRatio: 0.8,
    });
    expect(test.api("overhead.get", { sessionId: "empty" })).toEqual({ injectedTokens: 0 });
    expect(() => test.api("usage.query", { from: "2026-10-29T00:00:00Z", to: at })).toThrow(
      "invalid_usage_range",
    );
  } finally {
    test.close();
  }
});
it("persists a confirmed daily budget and audit once across command retries", async () => {
  const test = await fixture();
  try {
    const params = { scopeType: "day", scopeId: "2026-10-28", usd: 2, confirmed: true };
    expect(() => test.api("budget.set", { ...params, confirmed: false }, "bad")).toThrow(
      "human_budget_confirmation_required",
    );
    expect(test.api("budget.set", params, "budget")).toEqual({ ok: true });
    expect(test.api("budget.set", params, "budget")).toEqual({ ok: true });
    expect(test.store.snapshot().settings?.[0]).toMatchObject({
      key: "budget.day.2026-10-28",
      value: { usd: 2 },
    });
    expect(test.store.snapshot().audit).toHaveLength(1);
    const before = test.store.snapshot();
    test.store.rebuild();
    expect(test.store.snapshot()).toEqual(before);
  } finally {
    test.close();
  }
});
