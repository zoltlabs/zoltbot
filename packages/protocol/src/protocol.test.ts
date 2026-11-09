import { describe, expect, it } from "vitest";
import {
  AgentEventSchema,
  assertCatalogCoverage,
  eventCatalog,
  InteractionSchema,
  MessageSchema,
  macOnlyMethods,
  methodCatalog,
  ProfileSchema,
  parse,
  parseEvent,
  parseRequest,
  protocolVersion,
  TaskSchema,
} from "./index.js";

const at = "2026-10-27T12:00:00.000Z";
describe("protocol contracts", () => {
  it("exports an additive version and complete catalogs", () => {
    expect(protocolVersion).toBe(1);
    expect(methodCatalog).toHaveProperty("interaction.answer");
    expect(methodCatalog).toHaveProperty("workflow.run");
    expect(methodCatalog).toHaveProperty("device.pair.start");
    expect(eventCatalog).toHaveProperty("device.updated");
    for (const method of macOnlyMethods) expect(methodCatalog).toHaveProperty(method);
    expect(eventCatalog).toHaveProperty("interaction.resolved");
    expect(() => assertCatalogCoverage(["uncatalogued.method"], [])).toThrow(/uncatalogued/);
    expect(() => assertCatalogCoverage([], ["unknown.event"])).toThrow(/unknown.event/);
    assertCatalogCoverage(Object.keys(methodCatalog), Object.keys(eventCatalog));
  });
  it("round trips a profile without widening default permissions", () => {
    const profile = {
      id: "p1",
      name: "Builder",
      avatar: "B",
      definitionId: "local",
      kind: "profile",
      permissionProfile: "workspace_write",
      instructions: "Build carefully",
      hidden: false,
      archived: false,
    };
    expect(parse(ProfileSchema, JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    expect(() => parse(ProfileSchema, { ...profile, permissionProfile: "anything" })).toThrow(
      /permissionProfile/,
    );
  });
  it("rejects invalid task states and malformed payloads with a path", () => {
    expect(() => parse(TaskSchema, { id: "t1", state: "invented" })).toThrow(/Invalid payload/);
    expect(() =>
      parse(AgentEventSchema, { t: "text.delta", turnId: "t", itemId: "i", text: 5 }),
    ).toThrow();
    expect(() => parse(AgentEventSchema, { t: "future.event" })).toThrow();
  });
  it("preserves a durable gate interaction and compare and set version", () => {
    const gate = {
      id: "i1",
      version: 1,
      agentId: "p1",
      threadId: "h1",
      type: "gate",
      urgency: "blocking",
      state: "pending",
      items: [{ id: "gate", prompt: "Approve this design?" }],
      chain: [],
      createdAt: at,
      context: { deliverable: { id: "d1", kind: "design", summary: "New flow", checks: [] } },
    };
    expect(parse(InteractionSchema, gate)).toEqual(gate);
    expect(() => parse(InteractionSchema, { ...gate, version: 0 })).toThrow();
  });
  it("enforces envelope bounds and cannot accept unknown answer fields", () => {
    expect(() =>
      parse(MessageSchema, { to: Array.from({ length: 33 }, () => ({ kind: "agent", id: "x" })) }),
    ).toThrow();
    expect(() =>
      parse(methodCatalog["interaction.answer"].params, {
        id: "i",
        version: 1,
        answer: { action: "accept", by: { kind: "human", id: "h" }, at, secret: "bad" },
      }),
    ).toThrow();
  });
  it("validates normalized events and preserves provider order identifiers", () => {
    const events = [
      { t: "turn.started", turnId: "t1" },
      { t: "text.delta", turnId: "t1", itemId: "m1", text: "ok" },
      { t: "message.done", turnId: "t1", itemId: "m1", text: "ok", phase: "final" },
      { t: "turn.done", turnId: "t1", status: "completed" },
    ];
    expect(events.map((e) => parse(AgentEventSchema, JSON.parse(JSON.stringify(e))))).toEqual(
      events,
    );
  });
  it("rejects unknown methods and extra command fields", () => {
    expect(methodCatalog).not.toHaveProperty("shell.execute");
    expect(() =>
      parse(methodCatalog["turn.send"].params, {
        threadId: "x",
        input: [],
        mode: "queue",
        bypass: true,
      }),
    ).toThrow();
  });
});

describe("runtime catalog enforcement", () => {
  it("rejects handlers and events outside the catalog", () => {
    expect(() => parseRequest({ jsonrpc: "2.0", id: 1, method: "missing", params: {} })).toThrow(
      /Uncatalogued/,
    );
    expect(() =>
      parseEvent({
        eventId: "e",
        aggregateType: "task",
        aggregateId: "t",
        type: "missing",
        occurredAt: at,
        payload: {},
      }),
    ).toThrow(/Uncatalogued/);
  });
  it("checks event payloads before storage", () => {
    expect(() =>
      parseEvent({
        eventId: "e",
        aggregateType: "interaction",
        aggregateId: "i",
        type: "interaction.created",
        occurredAt: at,
        payload: { id: "i" },
      }),
    ).toThrow(/Invalid payload/);
    expect(parseRequest({ jsonrpc: "2.0", id: 1, method: "snapshot.get", params: {} }).method).toBe(
      "snapshot.get",
    );
  });
});
