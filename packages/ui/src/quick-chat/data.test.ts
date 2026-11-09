import type { QuickConnection, QuickMessage } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import {
  applyQuickEvent,
  billingLabel,
  errorText,
  initialSelection,
  replyLabel,
  toolName,
  toolSummary,
} from "./data.js";

const at = "2026-11-06T12:00:00.000Z";
const connection = (overrides: Partial<QuickConnection>): QuickConnection => ({
  id: "c",
  kind: "api_key",
  provider: "openai",
  label: "My key",
  billing: "user_api_key",
  host: { id: "local", name: "Studio Mac" },
  status: "ready",
  models: [
    { id: "big", label: "Big", source: "discovered" },
    { id: "fast-mini", label: "Mini", source: "discovered" },
  ],
  hasSecret: true,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});
it("names the billing source and host for each kind of connection", () => {
  expect(
    billingLabel({
      billing: "tool_sign_in",
      provider: "codex",
      label: "Codex",
      hostName: "Desktop",
    }),
  ).toBe("Your Codex sign-in · Desktop");
  expect(
    billingLabel({
      billing: "user_api_key",
      provider: "anthropic",
      label: "k",
      hostName: "Remote Mac",
    }),
  ).toBe("Your API key · Anthropic · Remote Mac");
  expect(
    billingLabel({
      billing: "local",
      provider: "openai_compatible",
      label: "Ollama",
      hostName: "Studio",
    }),
  ).toBe("Local model · Ollama · Studio");
  const reply = {
    billing: "local",
    provider: "openai_compatible",
    connectionLabel: "Ollama",
    hostName: "Studio",
    model: "llama",
  } as QuickMessage;
  expect(replyLabel(reply)).toBe("llama · Local model · Ollama · Studio");
});
it("selects the saved default, then a cheap discovered model, never an unusable connection", () => {
  const ready = connection({});
  const signedOut = connection({ id: "s", status: "needs_sign_in" });
  expect(initialSelection([signedOut, ready], undefined)).toEqual({
    connectionId: "c",
    model: "fast-mini",
  });
  expect(
    initialSelection([ready], {
      defaultConnectionId: "c",
      defaultModel: "big",
      deeperModels: {},
    }),
  ).toEqual({ connectionId: "c", model: "big" });
  expect(initialSelection([signedOut], undefined)).toBeUndefined();
  // The host's suggestion for a coding tool wins over the generic guess.
  expect(initialSelection([connection({ recommendedModel: "big" })], undefined)).toEqual({
    connectionId: "c",
    model: "big",
  });
  expect(initialSelection([ready], undefined, { connectionId: "c", model: "gone" })).toEqual({
    connectionId: "c",
    model: "fast-mini",
  });
});
it("applies unsequenced chat and message events to the open view only", () => {
  const message = {
    id: "m",
    chatId: "a",
    role: "assistant",
    text: "Hi",
    status: "streaming",
    context: [],
    createdAt: at,
  } as QuickMessage;
  const event = (type: string, payload: unknown) => ({
    eventId: "e",
    aggregateType: "x",
    aggregateId: "x",
    type,
    occurredAt: at,
    payload,
  });
  let state = applyQuickEvent(
    { chats: [], messages: [], chatId: "a" },
    event("quickMessage.changed", message),
  );
  expect(state.messages).toEqual([message]);
  state = applyQuickEvent(
    state,
    event("quickMessage.changed", { ...message, text: "Hi there", status: "complete" }),
  );
  expect(state.messages).toMatchObject([{ text: "Hi there", status: "complete" }]);
  expect(
    applyQuickEvent(state, event("quickMessage.changed", { ...message, id: "o", chatId: "b" })),
  ).toBe(state);
  state = applyQuickEvent(
    state,
    event("quickChat.changed", { id: "a", title: "A", updatedAt: at }),
  );
  expect(state.chats).toHaveLength(1);
  state = applyQuickEvent(state, event("quickChat.removed", { id: "a" }));
  expect(state).toMatchObject({ chats: [], messages: [] });
});
it("turns host error codes into readable text that keeps the draft", () => {
  expect(errorText(new Error("quick_connection_needs_sign_in: "))).toBe(
    "This connection needs you to sign in again.",
  );
  expect(errorText(new Error("something_new"))).toBe(
    "That did not work. Your draft is still here.",
  );
});
it("names tools and summarizes what a reply used", () => {
  expect(toolName("mcp__gmail__send_message")).toBe("gmail: send message");
  expect(toolName("quick_search")).toBe("quick search");
  expect(toolSummary(undefined)).toBe("");
  expect(
    toolSummary([
      { id: "1", name: "mcp__seoskill__seo_report", kind: "other", status: "ok" },
      {
        id: "2",
        name: "quick_read",
        kind: "read",
        title: "Read docs/billing.md",
        status: "running",
      },
      { id: "3", name: "mcp__seoskill__seo_report", kind: "other", status: "ok" },
    ]),
  ).toBe("Using seoskill: seo report, Read docs/billing.md");
});
