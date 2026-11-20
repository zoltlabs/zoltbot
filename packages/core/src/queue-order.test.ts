import { expect, it } from "vitest";
import { queueHumanInput } from "./input-queue.js";
import { applyEvents, type DomainState } from "./projectors.js";
import { queuedItems, reorderQueuedInput, sendQueuedInputNow } from "./queue-order.js";

const at = "2026-11-20T12:00:00Z";
const human = (commandId: string) => ({
  commandId,
  at,
  actor: { kind: "human" as const, id: "owner" },
});
const thread = {
  id: "thread",
  agentId: "profile",
  kind: "main",
  title: "Chat",
  titleSource: "human",
  pinned: false,
  archived: false,
  createdAt: at,
  lastActivityAt: at,
};
function queue(steer: "native" | "none", running: boolean): DomainState {
  let state: DomainState = {
    thread: [thread],
    session: [{ id: "session", threadId: "thread", state: "running", capabilities: { steer } }],
    ...(running ? { turn: [{ id: "turn", threadId: "thread", status: "running" }] } : {}),
  };
  for (const id of ["a", "b", "c"]) {
    const input = [{ type: "text" as const, text: id }];
    state = applyEvents(
      state,
      queueHumanInput(state, { threadId: "thread", input, mode: "queue" }, id, human(id)).events,
    );
  }
  return state;
}
const order = (state: DomainState) => queuedItems(state, "thread").map((row) => row.id);

it("reorders the queue and keeps later messages last", () => {
  let state = queue("none", true);
  state = applyEvents(
    state,
    reorderQueuedInput(state, "thread", ["c", "a", "b"], human("reorder")).events,
  );
  expect(order(state)).toEqual(["c", "a", "b"]);
  // Seqs never change, so the thread's unique (thread, seq) rows stay valid.
  expect(state.item?.map((row) => row.seq)).toEqual([1, 2, 3]);
  const input = [{ type: "text" as const, text: "d" }];
  state = applyEvents(
    state,
    queueHumanInput(state, { threadId: "thread", input, mode: "queue" }, "d", human("d")).events,
  );
  expect(order(state)).toEqual(["c", "a", "b", "d"]);
});

it("rejects a reorder against a changed queue", () => {
  const state = queue("none", true);
  expect(() => reorderQueuedInput(state, "thread", ["b", "a"], human("r"))).toThrow(
    "queue_changed",
  );
  expect(() => reorderQueuedInput(state, "thread", ["a", "a", "b"], human("r"))).toThrow(
    "queue_changed",
  );
  expect(() => reorderQueuedInput(state, "thread", ["a", "b", "x"], human("r"))).toThrow(
    "queue_changed",
  );
  expect(() => sendQueuedInputNow(state, "thread", "x", human("s"))).toThrow("queue_changed");
});

it("only the owner reorders", () => {
  const state = queue("none", true);
  const agent = { ...human("r"), actor: { kind: "agent" as const, id: "profile" } };
  expect(() => reorderQueuedInput(state, "thread", ["c", "b", "a"], agent)).toThrow(
    "human_input_required",
  );
});

it("send now steers a running turn when the agent supports it", () => {
  let state = queue("native", true);
  const outcome = sendQueuedInputNow(state, "thread", "c", human("now"));
  expect(outcome.result).toMatchObject({ delivery: "steer" });
  state = applyEvents(state, outcome.events);
  expect(order(state)).toEqual(["c", "a", "b"]);
  expect(state.item?.find((row) => row.id === "c")?.body).toMatchObject({ mode: "steer" });
  expect(state.item?.find((row) => row.id === "a")?.body).toMatchObject({ mode: "queue" });
});

it("send now moves the message to the front without native steering", () => {
  let state = queue("none", true);
  const outcome = sendQueuedInputNow(state, "thread", "b", human("now"));
  expect(outcome.result).toMatchObject({ delivery: "next" });
  state = applyEvents(state, outcome.events);
  expect(order(state)).toEqual(["b", "a", "c"]);
  expect(state.item?.find((row) => row.id === "b")?.body).toMatchObject({ mode: "queue" });
});

it("send now with nothing running just puts the message first", () => {
  const state = queue("native", false);
  const outcome = sendQueuedInputNow(state, "thread", "a", human("now"));
  expect(outcome.result).toMatchObject({ delivery: "next" });
  expect(order(applyEvents(state, outcome.events))).toEqual(["a", "b", "c"]);
});
