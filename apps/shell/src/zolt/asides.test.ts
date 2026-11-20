// @vitest-environment node
import { expect, it } from "vitest";
import type { ConversationMessage } from "../shared/ipc";
import { asideMessages, asideSource, withAsides } from "./asides";
import type { Row, Snapshot } from "./daemon-client";

const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`;
const snapshot = (entities: Record<string, Row[]>): Snapshot => ({
  seq: 1,
  entities,
  counters: {},
});
const aside = (id: string, minute: number, source = "chat"): Row => ({
  id,
  kind: "aside",
  createdAt: at(minute),
  fork: { sourceThreadId: source },
});
const question = (threadId: string, minute: number, text: string): Row => ({
  id: `${threadId}-q`,
  threadId,
  seq: 1,
  kind: "user",
  createdAt: at(minute),
  body: { input: [{ type: "text", text }] },
});
const message = (id: string, minute: number): ConversationMessage => ({
  id,
  author: "user",
  text: id,
  createdAt: at(minute),
  status: "completed",
});

it("shows an aside's question with a placeholder until the answer starts", () => {
  const state = snapshot({
    thread: [aside("a1", 2), aside("other", 2, "elsewhere")],
    item: [question("a1", 2, "Which file?")],
    turn: [{ id: "t1", threadId: "a1", status: "running" }],
  });
  expect(asideMessages(state, "chat")).toMatchObject([
    { author: "user", text: "Which file?", aside: { threadId: "a1" } },
    { id: "a1:pending", author: "assistant", status: "streaming", aside: { threadId: "a1" } },
  ]);
});

it("shows the answer and drops the placeholder", () => {
  const state = snapshot({
    thread: [aside("a1", 2)],
    item: [
      question("a1", 2, "Which file?"),
      {
        id: "a1-m",
        threadId: "a1",
        seq: 2,
        kind: "message",
        turnId: "t1",
        createdAt: at(3),
        body: { text: "src/main.ts" },
      },
    ],
    turn: [{ id: "t1", threadId: "a1", status: "completed" }],
  });
  expect(asideMessages(state, "chat").map((row) => [row.author, row.text, row.status])).toEqual([
    ["user", "Which file?", "completed"],
    ["assistant", "src/main.ts", "completed"],
  ]);
});

it("places each aside after the message that came just before it", () => {
  const state = snapshot({
    thread: [aside("a1", 2)],
    item: [question("a1", 2, "Why?")],
    turn: [],
  });
  const ids = withAsides(state, "chat", [message("m1", 1), message("m3", 3)]).map((row) => row.id);
  expect(ids).toEqual(["m1", "a1-q", "a1:pending", "m3"]);
  expect(withAsides(snapshot({}), "chat", [message("m1", 1)]).map((row) => row.id)).toEqual(["m1"]);
});

it("finds the chat an aside was asked in", () => {
  const state = snapshot({ thread: [aside("a1", 2), { id: "chat", kind: "main" }] });
  expect(asideSource(state, "a1")).toBe("chat");
  expect(asideSource(state, "chat")).toBeUndefined();
});
