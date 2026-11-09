import { expect, it } from "vitest";
import type { AgentEvent } from "./adapter-events.js";
import { AgentEventSchema } from "./adapter-events.js";
import { parse } from "./common.js";

// @ts-expect-error Unknown compaction states must be rejected by the static event type.
const invalid: AgentEvent = { t: "compaction", state: "not-a-state", trigger: "manual" };
it("keeps nested event enums strict in TypeScript and runtime validation", () => {
  expect(() => parse(AgentEventSchema, invalid)).toThrow();
  expect(
    parse(AgentEventSchema, { t: "compaction", state: "started", trigger: "manual" }),
  ).toMatchObject({ state: "started" });
});
