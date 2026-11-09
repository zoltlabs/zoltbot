import { Value } from "@sinclair/typebox/value";
import { ConnectionSchema, entitySchemas } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { FakeTransport } from "./fake.js";
import { sampleManagement } from "./fake-manage.js";

const routine = async (fake: FakeTransport, id: string) => {
  const { entities } = (await fake.call("snapshot.get", {})) as {
    entities: { routine: { id: string; updatedAt: string; paused: boolean }[] };
  };
  const row = entities.routine.find((entry) => entry.id === id);
  if (!row) throw new Error(`missing ${id}`);
  return row;
};

describe("sample management", () => {
  it("uses the real protocol shapes", async () => {
    for (const [kind, rows] of Object.entries(
      sampleManagement(Date.parse("2026-11-08T12:00:00Z")),
    )) {
      const schema = entitySchemas[kind as keyof typeof entitySchemas];
      expect(schema, kind).toBeDefined();
      for (const row of rows)
        expect(Value.Errors(schema, row).First(), `${kind} ${row.id}`).toBeUndefined();
    }
    const { items } = (await new FakeTransport().call("connection.list", {})) as {
      items: unknown[];
    };
    for (const row of items) expect(Value.Errors(ConnectionSchema, row).First()).toBeUndefined();
  });

  it("refuses a routine edit made from a stale copy", async () => {
    const fake = new FakeTransport();
    const before = await routine(fake, "routine-sync-check");
    await fake.call(
      "routine.update",
      { id: "routine-sync-check", expectedUpdatedAt: before.updatedAt, paused: false },
      "r1",
    );
    const after = await routine(fake, "routine-sync-check");
    expect(after.paused).toBe(false);
    await expect(
      fake.call(
        "routine.update",
        {
          id: "routine-sync-check",
          expectedUpdatedAt: before.updatedAt,
          schedule: { cron: "@every 30m", timezone: "UTC" },
        },
        "r2",
      ),
    ).rejects.toThrow("stale_revision");
    await expect(
      fake.call(
        "routine.update",
        {
          id: "routine-sync-check",
          expectedUpdatedAt: after.updatedAt,
          schedule: { cron: "0 9 1 * *", timezone: "UTC" },
        },
        "r3",
      ),
    ).rejects.toThrow("invalid_routine_schedule");
  });

  it("checks knowledge revisions on edit and archive", async () => {
    const fake = new FakeTransport();
    const { entities } = (await fake.call("snapshot.get", {})) as {
      entities: { knowledge: { id: string; revision: number }[] };
    };
    const item = entities.knowledge.find((row) => row.id === "knowledge-metric");
    if (!item) throw new Error("missing sample");
    await fake.call(
      "knowledge.upsert",
      { value: { ...item, title: "Metric first" }, expectedRevision: 1 },
      "k1",
    );
    await expect(
      fake.call("knowledge.upsert", { value: item, expectedRevision: 1 }, "k2"),
    ).rejects.toThrow("knowledge_revision_conflict");
    await expect(
      fake.call("knowledge.archive", { id: item.id, expectedRevision: 1 }, "k3"),
    ).rejects.toThrow("knowledge_revision_conflict");
    await fake.call("knowledge.archive", { id: item.id, expectedRevision: 2 }, "k4");
  });

  it("turns skills on only when confirmed, per agent and project", async () => {
    const fake = new FakeTransport();
    const access = {
      profileId: "checker",
      scopeId: "site",
      skillId: "skill-sql-safety",
      revision: 1,
    };
    await expect(
      fake.call("skill.access", { ...access, enabled: true, confirmed: false }, "s1"),
    ).rejects.toThrow("skill_enable_confirmation_required");
    await fake.call("skill.access", { ...access, enabled: true, confirmed: true }, "s2");
    expect(await fake.call("skill.assignments", { profileId: "checker", scopeId: "site" })).toEqual(
      { assignments: [{ skillId: "skill-sql-safety", revision: 1 }] },
    );
    expect(await fake.call("skill.assignments", { profileId: "builder", scopeId: "site" })).toEqual(
      { assignments: [] },
    );
  });

  it("disconnects only the version and chats the phone confirmed", async () => {
    const fake = new FakeTransport();
    const id = "connection-github";
    const params = { id, confirmed: true, stopSessions: true, expectedVersion: 1 };
    await expect(
      fake.call("connection.disconnect", { ...params, expectedSessionIds: [] }, "c1"),
    ).rejects.toThrow("connection_disconnect_changed");
    await fake.call(
      "connection.disconnect",
      { ...params, expectedSessionIds: ["session-meal"] },
      "c2",
    );
    const { items } = (await fake.call("connection.list", {})) as {
      items: { id: string; enabled: boolean; credentialReference?: string }[];
    };
    expect(items.find((row) => row.id === id)).toMatchObject({ enabled: false });
    expect(items.find((row) => row.id === id)?.credentialReference).toBeUndefined();
    await expect(fake.call("connection.test", { id: "connection-posthog" }, "c3")).rejects.toThrow(
      "connection_health_failed",
    );
  });

  it("refuses a settings write made from a stale value", async () => {
    const fake = new FakeTransport();
    await fake.call("settings.set", { key: "ui.cas", value: { a: 1 }, expected: {} }, "x1");
    await expect(
      fake.call("settings.set", { key: "ui.cas", value: { a: 2 }, expected: {} }, "x2"),
    ).rejects.toThrow("setting_conflict");
    await fake.call(
      "settings.set",
      { key: "ui.cas", value: { a: 2 }, expected: { value: { a: 1 } } },
      "x3",
    );
  });

  it("delivers a person's message to another chat like typing there", async () => {
    const fake = new FakeTransport({ replyDelayMs: 1 });
    const message = {
      id: "msg-forward",
      thread: "thread-rate-limits",
      fromThread: "thread-meal-search",
      from: { kind: "human", id: "local-owner" },
      to: [{ kind: "agent", id: "checker" }],
      kind: "message",
      expectsReply: false,
      priority: "normal",
      delivery: "next_turn",
      root: "msg-forward",
      hops: 0,
      ttlHops: 6,
      origin: "human",
      body: [{ type: "text", text: "Check the 429 handling too." }],
      createdAt: "2026-11-08T12:00:00.000Z",
    };
    const result = (await fake.call("message.send", { message }, "m1")) as {
      deliveries: { id: string }[];
    };
    const { entities } = (await fake.call("snapshot.get", {})) as {
      entities: { item: { id: string; threadId: string }[] };
    };
    expect(entities.item.find((row) => row.id === result.deliveries[0]?.id)?.threadId).toBe(
      "thread-rate-limits",
    );
    expect(await fake.call("message.send", { message }, "m1")).toEqual(result);
    await expect(
      fake.call(
        "message.send",
        { message: { ...message, id: "msg-other", to: [{ kind: "agent", id: "builder" }] } },
        "m2",
      ),
    ).rejects.toThrow("message_target_mismatch");
  });
});
