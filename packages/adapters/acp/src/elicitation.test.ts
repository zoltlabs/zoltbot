import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { expect, it } from "vitest";
import { elicitationForm, elicitationResponse } from "./elicitation.js";

const request: CreateElicitationRequest = {
  mode: "form",
  sessionId: "s",
  message: "Configure",
  requestedSchema: {
    type: "object",
    properties: { name: { type: "string" }, count: { type: "integer", minimum: 1 } },
    required: ["name", "count"],
  },
};
it("keeps the full form schema and validates accepted answers", () => {
  const form = elicitationForm(request, { id: "i", agentId: "a", threadId: "t", turnId: "turn" });
  expect(form?.items[0]?.schema).toEqual(request.requestedSchema);
  expect(
    elicitationResponse(request, {
      action: "accept",
      answers: { form: { value: { name: "test", count: 2 } } },
      by: { kind: "human", id: "owner" },
      at: "2026-10-27T00:00:00Z",
    }),
  ).toEqual({ action: "accept", content: { name: "test", count: 2 } });
  expect(() =>
    elicitationResponse(request, {
      action: "accept",
      answers: { form: { value: { count: 0 } } },
      by: { kind: "human", id: "owner" },
      at: "2026-10-27T00:00:00Z",
    }),
  ).toThrow("invalid_form_answer");
  expect(elicitationResponse(request, undefined)).toEqual({ action: "cancel" });
});
it("declines unsupported URL elicitation without opening a URL", () => {
  const request: CreateElicitationRequest = {
    mode: "url",
    sessionId: "s",
    message: "Login",
    elicitationId: "e",
    url: "https://example.test",
  };
  expect(
    elicitationForm(request, { id: "i", agentId: "a", threadId: "t", turnId: "turn" }),
  ).toBeUndefined();
});
