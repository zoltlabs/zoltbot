import { expect, it } from "vitest";
import { AgentEventSchema, parse } from "./index.js";

it("preserves normalized parent item linkage and rejects malformed parent ids", () => {
  const event = {
    t: "tool.started",
    turnId: "turn",
    itemId: "child",
    parentItemId: "parent",
    name: "Read",
    kind: "read",
    input: {},
  };
  expect(parse(AgentEventSchema, event)).toEqual(event);
  expect(() => parse(AgentEventSchema, { ...event, parentItemId: 1 })).toThrow("Invalid payload");
});
