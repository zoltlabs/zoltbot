import { Value } from "@sinclair/typebox/value";
import { entitySchemas } from "@zoltbot/protocol";
import { describe, expect, it, vi } from "vitest";
import { accountViews, chatAccount, toOrders } from "./backup-models.js";
import { createClient } from "./client.js";
import { FakeTransport } from "./fake.js";
import { seedManagerSample } from "./fake-manager.js";
import { transcript } from "./timeline.js";
import type { Row } from "./transport.js";
import { needsYou } from "./view.js";

const now = Date.parse("2026-11-19T14:00:00.000Z");

describe("manager sample", () => {
  it("uses the real protocol entity shapes", () => {
    const entities: Record<string, Row[]> = {};
    seedManagerSample(entities, now);
    for (const [kind, rows] of Object.entries(entities)) {
      const schema = entitySchemas[kind as keyof typeof entitySchemas];
      expect(schema, kind).toBeDefined();
      for (const row of rows)
        expect(Value.Errors(schema, row).First(), `${kind} ${row.id ?? row.key}`).toBeUndefined();
    }
  });

  it("shows Mira's cards, the staff approval and Sam's switch", async () => {
    const client = createClient(new FakeTransport({ now: () => now }));
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    const snapshot = client.getState().snapshot;
    const mira = transcript(snapshot, "thread-mira");
    expect(mira.map((row) => row.id)).toEqual([
      "mira-ask",
      "mira-plan",
      "card:delegation:turn-mira-1",
      "notice:sent:tip-theo",
      "mira-note",
      "card:result:task-invoice",
      "card:staff:staff-approval-juno",
      "notice:waiting:wait-mira",
    ]);
    expect(mira[3]?.text).toBe("Mira → Theo: use the EU fixtures");
    const sam = transcript(snapshot, "thread-task-rounding");
    expect(sam.find((row) => row.switchNote)?.text).toMatch(
      /^Switched to Work\. Back to Personal at /,
    );
    expect(chatAccount(snapshot, "thread-task-rounding")).toBe("Work");
    expect(needsYou(snapshot).map((item) => item.id)).toEqual(
      expect.arrayContaining(["staff-approval-juno", "backup-sam"]),
    );
    client.stop();
  });

  it("answers the staff approval, the allowance, Wake now and the backup order", async () => {
    const client = createClient(new FakeTransport({ now: () => now }));
    await vi.waitFor(() => expect(client.getState().status).toBe("online"));
    const call = client.getState().call;
    await call("interaction.answer", {
      id: "staff-approval-juno",
      version: 1,
      answer: {
        action: "accept",
        choice: "allow_once",
        answers: { change: { options: ["allowance"] } },
        by: { kind: "human", id: "local-owner" },
        at: new Date(now).toISOString(),
      },
    });
    await call("staff.allowance", {
      threadId: "thread-mira",
      max: 4,
      models: ["Sonnet"],
      folders: ["apps/web/tests"],
    });
    await call("company.wakeNow", { threadId: "thread-mira", waitId: "wait-mira" });
    const list = (await call("modelAccount.list", {})) as Row;
    const views = accountViews(
      list.items as Row[],
      client.getState().snapshot.entities.agentDefinition ?? [],
    );
    expect(views.map((view) => view.name)).toEqual(["Claude · Personal", "Claude · Work", "Codex"]);
    const orders = toOrders(
      await call("backupOrder.set", { role: "manager", entries: [{ accountId: "default:codex" }] }),
    );
    expect(orders.manager).toEqual([{ accountId: "default:codex" }]);
    await call("settings.set", { key: "tasks.runningLimit", value: 4 });

    const snapshot = client.getState().snapshot;
    const settings = (key: string) =>
      snapshot.entities.settings?.find((row) => row.key === key)?.value as Row;
    expect(settings("staff.allowance.thread-mira")).toMatchObject({ max: 4 });
    expect(settings("team.wait.thread-mira")).toMatchObject({ status: "woken", reason: "owner" });
    expect(settings("tasks.runningLimit")).toBe(4);
    expect(transcript(snapshot, "thread-mira").some((row) => row.notice?.kind === "waiting")).toBe(
      false,
    );
    for (const [kind, rows] of Object.entries(snapshot.entities)) {
      const schema = entitySchemas[kind as keyof typeof entitySchemas];
      for (const row of rows)
        expect(Value.Errors(schema, row).First(), `${kind} ${row.id ?? row.key}`).toBeUndefined();
    }
    client.stop();
  });
});
