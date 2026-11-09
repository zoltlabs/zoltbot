import { expect, it } from "vitest";
import { SessionTokens } from "./session-tokens.js";

const first = { agentId: "agent-a", threadId: "thread-a", sessionId: "session-a" };
const second = { agentId: "agent-a", threadId: "thread-b", sessionId: "session-b" };

it("authenticates independent session identities without trusting tool arguments", () => {
  const sessions = new SessionTokens();
  const a = sessions.issue(first);
  const b = sessions.issue(second);
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(sessions.authenticate(`Bearer ${a}`)).toEqual(first);
  expect(sessions.authenticate(`bearer ${b}`)).toEqual(second);
  sessions.setTurn(first.sessionId, "turn-a");
  expect(sessions.authenticate(`Bearer ${a}`)).toEqual({ ...first, turnId: "turn-a" });
  expect(sessions.authenticate(`Bearer ${b}`)).toEqual(second);
  sessions.setTurn(first.sessionId, undefined);
  expect(sessions.authenticate(`Bearer ${a}`)).toEqual(first);
});

it("does not expose mutable authority and refuses missing, malformed, or unknown tokens", () => {
  const sessions = new SessionTokens();
  const identity = { ...first };
  const token = sessions.issue(identity);
  identity.threadId = "injected-thread";
  const actor = sessions.authenticate(`Bearer ${token}`);
  if (!actor) throw new Error("missing_actor");
  actor.agentId = "injected-agent";
  expect(sessions.authenticate(`Bearer ${token}`)).toEqual(first);
  for (const header of [
    undefined,
    "",
    token,
    `Basic ${token}`,
    `Bearer ${token} extra`,
    `Bearer ${token}, Bearer ${token}`,
    `Bearer ${token}\n`,
    `Bearer ${"x".repeat(43)}`,
  ]) {
    expect(sessions.authenticate(header)).toBeUndefined();
  }
  expect(() => sessions.issue(first)).toThrow("session_token_exists");
});

it("revokes only the requested session and closes all authority on shutdown", () => {
  const sessions = new SessionTokens();
  const a = sessions.issue(first);
  const b = sessions.issue(second);
  sessions.revoke(first.sessionId);
  sessions.revoke(first.sessionId);
  expect(sessions.authenticate(`Bearer ${a}`)).toBeUndefined();
  expect(sessions.authenticate(`Bearer ${b}`)).toEqual(second);
  expect(() => sessions.setTurn(first.sessionId, "later")).toThrow("session_token_unavailable");
  const replacement = sessions.issue(first);
  expect(replacement).not.toBe(a);
  expect(sessions.authenticate(`Bearer ${a}`)).toBeUndefined();
  sessions.close();
  sessions.close();
  expect(sessions.authenticate(`Bearer ${b}`)).toBeUndefined();
  expect(sessions.authenticate(`Bearer ${replacement}`)).toBeUndefined();
  expect(() => sessions.issue(first)).toThrow("session_tokens_closed");
});

it("rejects invalid identities before allocating authority", () => {
  const sessions = new SessionTokens();
  for (const identity of [
    { ...first, agentId: "" },
    { ...first, sessionId: "x".repeat(257) },
  ])
    expect(() => sessions.issue(identity)).toThrow("invalid_session_identity");
  sessions.issue(first);
  expect(() => sessions.setTurn(first.sessionId, "")).toThrow("invalid_turn_identity");
});
