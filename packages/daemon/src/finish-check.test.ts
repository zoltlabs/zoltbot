import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { at } from "../../../tools/fakes/src/runtime-fixture.js";
import {
  CONTINUE_TEXT,
  continueSettingKey,
  endsOnPromise,
  finishCheck,
  unfinishedTurn,
} from "./finish-check.js";

it("spots replies that end on a promise", () => {
  expect(endsOnPromise("Found the bug. I'll fix it now.")).toBe(true);
  expect(endsOnPromise("Tests pass.\n\nNext I run the build.")).toBe(true);
  expect(endsOnPromise("Let me check the logs")).toBe(true);
  expect(endsOnPromise("- Now I'll update the docs.")).toBe(true);
  expect(endsOnPromise("I'll fix it. Done: the tests pass.")).toBe(false);
  expect(endsOnPromise("Should I fix it now?")).toBe(false);
  expect(endsOnPromise("I'll fix it if you want?")).toBe(false);
  expect(endsOnPromise("All done.")).toBe(false);
  expect(endsOnPromise("Fixed. Let me know if you'd like any changes.")).toBe(false);
  expect(endsOnPromise("I'll wait for your go-ahead.")).toBe(false);
  expect(endsOnPromise("I will not touch the config.")).toBe(false);
  expect(endsOnPromise("Now, let me run the build.")).toBe(true);
  expect(endsOnPromise("")).toBe(false);
});

async function fixture(reply: string, origin?: string) {
  const f = await forkFixture();
  const thread = f.store.record("thread", "thread") as Record<string, unknown>;
  f.put("thread", { ...thread, kind: "main" });
  const agent = f.store.record("agent", String(thread.agentId)) as Record<string, unknown>;
  f.put("agent", { ...agent, permissionProfile: "workspace_write" });
  f.put("item", {
    id: "owner-1",
    threadId: "thread",
    seq: 2,
    kind: "user",
    body: {
      input: [{ type: "text", text: "Fix the build" }],
      queueState: "handled",
      ...(origin ? { origin } : {}),
    },
    createdAt: at,
  });
  f.put("turn", {
    id: "turn-1",
    threadId: "thread",
    sessionId: "session",
    status: "completed",
    origin: "human",
    startedAt: at,
    endedAt: at,
  });
  f.put("item", {
    id: "reply-1",
    threadId: "thread",
    turnId: "turn-1",
    seq: 3,
    kind: "message",
    phase: "final",
    body: { text: reply },
    createdAt: at,
  });
  return f;
}

it("continues a turn that ended on a promise, once per owner message", async () => {
  const f = await fixture("Found it in the config. I'll fix it now.");
  try {
    expect(unfinishedTurn(f.store.snapshot(), "turn-1")?.id).toBe("owner-1");
    const woke: string[] = [];
    const published: unknown[] = [];
    const check = finishCheck({
      store: f.store,
      publish: (events) => published.push(...events),
      wake: async (id) => woke.push(id),
    });
    const done = [
      {
        aggregateType: "turn",
        aggregateId: "turn-1",
        payload: { status: "completed" },
      },
    ] as never;
    check.observe(done);
    await new Promise((resolve) => setImmediate(resolve));
    const queued = f.store.record("item", "finish-check:owner-1:input") as {
      body: { input: { text: string }[]; notice: unknown; origin: string };
    };
    expect(queued.body.input[0]?.text).toBe(CONTINUE_TEXT);
    expect(queued.body.notice).toEqual({ kind: "continue" });
    expect(queued.body.origin).toBe("system");
    expect(woke).toEqual(["thread"]);
    // A second promise before the person writes again gets nothing.
    const count = published.length;
    check.observe(done);
    await new Promise((resolve) => setImmediate(resolve));
    expect(published.length).toBe(count);
    check.close();
  } finally {
    f.close();
  }
});

it("leaves finished work, tool calls, questions, forks and switched-off agents alone", async () => {
  const f = await fixture("I'll run the tests.");
  try {
    f.put("item", {
      id: "tool-1",
      threadId: "thread",
      turnId: "turn-1",
      seq: 4,
      kind: "tool",
      body: {},
      createdAt: at,
    });
    expect(unfinishedTurn(f.store.snapshot(), "turn-1")).toBeUndefined();
  } finally {
    f.close();
  }
  for (const change of [
    "interaction",
    "fork",
    "off",
    "aside",
    "queued",
    "readOnly",
    "newerTurn",
  ] as const) {
    const g = await fixture("I'll run the tests.");
    try {
      const thread = g.store.record("thread", "thread") as Record<string, unknown>;
      if (change === "interaction")
        g.put("item", {
          id: "ask-1",
          threadId: "thread",
          turnId: "turn-1",
          seq: 4,
          kind: "interaction",
          body: {},
          createdAt: at,
        });
      if (change === "fork")
        g.put("thread", {
          ...thread,
          fork: {
            operationId: "fork-1",
            sourceThreadId: "other",
            sourceSessionId: "session",
            cwd: "/tmp",
            boundary: { kind: "latest" },
            permissionCeiling: "workspace_write",
            inheritedHistoryPresent: true,
          },
        });
      if (change === "aside") g.put("thread", { ...thread, kind: "aside" });
      if (change === "off")
        g.put("settings", { key: continueSettingKey(String(thread.agentId)), value: false });
      if (change === "readOnly") {
        const agent = g.store.record("agent", String(thread.agentId)) as Record<string, unknown>;
        g.put("agent", { ...agent, permissionProfile: "read_only" });
      }
      if (change === "queued")
        g.put("item", {
          id: "owner-2",
          threadId: "thread",
          seq: 4,
          kind: "user",
          body: { input: [{ type: "text", text: "Wait" }], queueState: "queued" },
          createdAt: at,
        });
      if (change === "newerTurn")
        g.put("turn", {
          id: "turn-2",
          threadId: "thread",
          sessionId: "session",
          status: "running",
          origin: "human",
          startedAt: at,
        });
      expect(unfinishedTurn(g.store.snapshot(), "turn-1"), change).toBeUndefined();
    } finally {
      g.close();
    }
  }
});

it("counts phone messages as the owner's and skips turns a teammate started", async () => {
  const phone = await fixture("I'll fix it now.", "human");
  try {
    expect(unfinishedTurn(phone.store.runtimeSnapshot("thread"), "turn-1")?.id).toBe("owner-1");
  } finally {
    phone.close();
  }
  const team = await fixture("I'll fix it now.", "agent");
  try {
    expect(unfinishedTurn(team.store.runtimeSnapshot("thread"), "turn-1")).toBeUndefined();
  } finally {
    team.close();
  }
});
