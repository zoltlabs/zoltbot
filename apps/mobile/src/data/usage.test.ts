import { Value } from "@sinclair/typebox/value";
import { UsageRecordSchema } from "@zoltbot/protocol";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "./client.js";
import { FakeTransport } from "./fake.js";
import type { Row } from "./transport.js";
import { formatCost, formatTokens, usageByChat, usageFrom } from "./usage.js";

const now = Date.parse("2026-11-19T14:00:00.000Z");

describe("usage", () => {
  const entities = {
    session: [
      { id: "s1", threadId: "t1" },
      { id: "s2", threadId: "t2" },
    ],
    thread: [
      { id: "t1", title: "Release notes" },
      { id: "t2", title: "Research" },
    ],
  };
  const records: Row[] = [
    { sessionId: "s1", inputTokens: 100, outputTokens: 20, costUsd: 1.5, costKnown: true },
    { sessionId: "s2", inputTokens: 9000, costUsd: 0.25, costKnown: true },
    { sessionId: "s2", inputTokens: 10, costKnown: false },
  ];

  it("totals records by chat and sorts by cost or tokens", () => {
    const byCost = usageByChat(records, entities, "cost");
    expect(byCost).toEqual([
      { threadId: "t1", name: "Release notes", costUsd: 1.5, costKnown: true, tokens: 120 },
      { threadId: "t2", name: "Research", costUsd: 0.25, costKnown: false, tokens: 9010 },
    ]);
    expect(usageByChat(records, entities, "tokens").map((row) => row.name)).toEqual([
      "Research",
      "Release notes",
    ]);
  });

  it("starts each range at local midnight", () => {
    expect(usageFrom("7d", new Date(2026, 0, 10, 15))).toEqual(new Date(2026, 0, 4));
    expect(usageFrom("today", new Date(2026, 0, 10, 15))).toEqual(new Date(2026, 0, 10));
  });

  it("formats cost and tokens", () => {
    expect(formatCost(1.5, true)).toBe("$1.50");
    expect(formatCost(0.25, false)).toBe("$0.25+");
    expect(formatTokens(9010)).toBe("9,010");
    expect(formatTokens(45_200)).toBe("45K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  it("gets real usage records from the sample daemon, only from the start date", async () => {
    const client = createClient(new FakeTransport({ now: () => now }));
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    let id = 0;
    // Each call needs its own command id; a repeated id returns the first answer.
    const call = (method: string, params: Row) =>
      client.getState().call(method, params, `test-${method}-${id++}`);
    const all = (await call("usage.query", { from: "2000-01-01T00:00:00.000Z" })) as Row[];
    expect(all.length).toBeGreaterThan(1);
    for (const row of all) expect(Value.Errors(UsageRecordSchema, row).First()).toBeUndefined();
    // From the newest record's time, only that record and any at the same time come back.
    const from = String(all.at(-1)?.recordedAt);
    const rows = (await call("usage.query", { from })) as Row[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(all.length);
    for (const row of rows) expect(String(row.recordedAt) >= from).toBe(true);
    expect(usageByChat(all, client.getState().snapshot.entities, "cost")[0]?.name).not.toBe("");
  });
});
