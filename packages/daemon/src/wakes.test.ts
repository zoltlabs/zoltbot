import {
  type CommandContext,
  type DomainState,
  handle,
  type Outcome,
  saveWake,
} from "@zoltbot/core";
import { parseRequest, type Wake, type WakeInput } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { wakeService } from "./wakes.js";

const at = "2026-11-09T12:00:00.000Z";
const fallbackAt = "2026-11-10T12:00:00.000Z";
async function fixture() {
  const f = await runtimeFixture();
  let now = at,
    serial = 0;
  const run = (work: (s: DomainState, c: CommandContext) => Outcome) => {
    const commandId = `test:${++serial}`;
    return f.store.dispatch(commandId, (s) =>
      work(s, { commandId, at: now, actor: { kind: "human", id: "owner" } }),
    ).result;
  };
  run((s, c) =>
    handle(
      s,
      {
        type: "update",
        kind: "session",
        id: "session",
        changes: {
          background: [{ id: "job", kind: "shell", description: "Tests", state: "running" }],
        },
      },
      c,
    ),
  );
  const input: WakeInput = {
    threadId: "thread",
    condition: { kind: "job", sessionId: "session", jobId: "job", outcome: "finished" },
    fallbackAt,
    behavior: "resume",
    continuation: "Review test results",
  };
  return {
    ...f,
    input,
    run,
    setNow: (time: string) => {
      now = time;
    },
    now: () => now,
  };
}
it("persists and reconciles a finished job across service restart, without duplicate queue delivery", async () => {
  const f = await fixture();
  let delivered = 0;
  const options = {
    store: f.store,
    publish() {},
    wake: async () => {
      delivered++;
    },
    checkPublic: async () => () => {},
    now: f.now,
    onError() {},
  };
  let service = wakeService(options);
  try {
    const saved = (await service.api("wake.save", { input: f.input }, "save")) as Wake;
    await service.tick();
    await service.close();
    f.run((s, c) =>
      handle(
        s,
        {
          type: "update",
          kind: "session",
          id: "session",
          changes: {
            background: [{ id: "job", kind: "shell", description: "Tests", state: "failed" }],
          },
        },
        c,
      ),
    );
    service = wakeService(options);
    await service.tick();
    await service.tick();
    expect(f.store.snapshot(["item"]).item?.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(f.store.record("wake", saved.id)).toMatchObject({
      status: "queued",
      reason: expect.stringContaining("failed"),
    });
    expect(delivered).toBeGreaterThan(0);
    expect(await service.api("wake.save", { input: f.input }, "save")).toMatchObject({
      id: saved.id,
    });
    f.store.rebuild();
    expect(f.store.record("wake", saved.id)?.status).toBe("queued");
  } finally {
    await service.close();
    f.close();
  }
});
it("reconciles exact GitHub state and attempt, binds identities, and rejects changed accounts", async () => {
  const f = await fixture();
  let merged = false,
    account = 7;
  const calls: string[] = [];
  const service = wakeService({
    store: f.store,
    publish() {},
    wake: async () => {},
    checkPublic: async () => () => {},
    now: f.now,
    onError() {},
    transport: async (endpoint, method) => {
      expect(method).toBe("GET");
      calls.push(endpoint);
      if (endpoint === "/user") return { id: account };
      if (endpoint === "/repos/example/app") return { id: 9, full_name: "example/app" };
      if (endpoint === "/repos/example/app/pulls/4") return { number: 4, merged, state: "open" };
      throw new Error("unexpected endpoint");
    },
  });
  try {
    const w = (await service.api(
      "wake.save",
      { input: { ...f.input, condition: { kind: "pr", repository: "example/app", number: 4 } } },
      "pr-save",
    )) as Wake;
    await service.tick();
    account = 8;
    merged = true;
    await service.tick();
    expect(f.store.record("wake", w.id)).toMatchObject({ status: "needs_attention" });
    expect(f.store.snapshot(["item"]).item ?? []).toHaveLength(0);
    account = 7;
    await service.tick();
    expect(f.store.record("wake", w.id)).toMatchObject({
      status: "queued",
      evidenceUrl: "https://github.com/example/app/pull/4",
    });
    expect(calls).toContain("/repos/example/app/pulls/4");
  } finally {
    await service.close();
    f.close();
  }
});
it("fallback wins after sleep; closed targets cancel; stale checks cannot overwrite edits", async () => {
  const f = await fixture();
  const service = wakeService({
    store: f.store,
    publish() {},
    wake: async () => {
      throw new Error("must not run");
    },
    checkPublic: async () => () => {},
    now: f.now,
    onError() {},
  });
  try {
    const saved = (await service.api("wake.save", { input: f.input }, "save")) as Wake;
    await service.tick();
    f.setNow("2026-11-11T12:00:00.000Z");
    await service.tick();
    expect(f.store.record("wake", saved.id)).toMatchObject({
      status: "consumed",
      reason: expect.stringContaining("not been confirmed"),
    });
    expect(f.store.snapshot(["item"]).item?.filter((i) => i.kind === "user") ?? []).toEqual([]);
  } finally {
    await service.close();
    f.close();
  }
});
it("the wire catalog validates exact source ids and mandatory fallback", () => {
  expect(() =>
    parseRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "wake.save",
      commandId: "x",
      params: {
        input: {
          threadId: "thread",
          condition: { kind: "pr", repository: "../bad", number: 1 },
          behavior: "inbox",
          continuation: "",
        },
      },
    }),
  ).toThrow();
});
it("topic monitoring never treats queued system notices as human messages", async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.run((s, c) =>
        saveWake(
          s,
          {
            ...f.input,
            behavior: "resume",
            condition: { kind: "topic", projectId: "p", phrase: "tests" },
          },
          "topic",
          c,
        ),
      ),
    ).toThrow("topic_scope");
  } finally {
    f.close();
  }
});

it("checks the exact CI attempt and distinguishes terminal failure from a passing run", async () => {
  const f = await fixture();
  let conclusion = "failure",
    status = "completed",
    delivered = 0;
  const endpoints: string[] = [];
  const service = wakeService({
    store: f.store,
    publish() {},
    wake: async () => {
      delivered++;
    },
    checkPublic: async () => () => {},
    now: f.now,
    onError() {},
    transport: async (endpoint) => {
      endpoints.push(endpoint);
      if (endpoint === "/user") return { id: 1 };
      if (endpoint === "/repos/example/app") return { id: 2, full_name: "example/app" };
      if (endpoint === "/repos/example/app/actions/runs/99/attempts/2")
        return { id: 99, run_attempt: 2, status, conclusion };
      throw new Error("unexpected endpoint");
    },
  });
  try {
    const saved = (await service.api(
      "wake.save",
      {
        input: {
          ...f.input,
          condition: {
            kind: "ci",
            repository: "example/app",
            runId: "99",
            attempt: 2,
            outcome: "finished",
          },
        },
      },
      "ci-save",
    )) as Wake;
    await service.tick();
    expect(f.store.record("wake", saved.id)).toMatchObject({
      status: "queued",
      reason: expect.stringContaining("failure"),
    });
    expect(endpoints.some((e) => e.endsWith("/attempts/2"))).toBe(true);
    expect(endpoints.some((e) => e.endsWith("/runs/99"))).toBe(false);
    expect(delivered).toBeGreaterThan(0);
    // A new passing-only wait does not accept a failed terminal result.
    const queued = f.store.snapshot(["item"]).item?.find((i) => i.kind === "user");
    if (queued)
      f.run((s, c) =>
        handle(
          s,
          {
            type: "update",
            kind: "item",
            id: String(queued.id),
            changes: { body: { ...(queued.body as object), queueState: "handled" } },
          },
          c,
        ),
      );
    await service.tick();
    status = "in_progress";
    const passing = (await service.api(
      "wake.save",
      {
        input: {
          ...f.input,
          condition: {
            kind: "ci",
            repository: "example/app",
            runId: "99",
            attempt: 2,
            outcome: "passed",
          },
        },
      },
      "ci-passing",
    )) as Wake;
    await service.tick();
    status = "completed";
    await service.tick();
    expect(f.store.record("wake", passing.id)?.status).toBe("needs_attention");
    conclusion = "success";
    await service.tick();
    expect(f.store.record("wake", passing.id)?.status).toBe("queued");
  } finally {
    await service.close();
    f.close();
  }
});

it("does not overwrite cancellation when an in-flight remote check resolves", async () => {
  const f = await fixture();
  let pause = false,
    release: (() => void) | undefined,
    started: (() => void) | undefined;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const service = wakeService({
    store: f.store,
    publish() {},
    wake: async () => {},
    checkPublic: async () => () => {},
    now: f.now,
    onError() {},
    transport: async (endpoint) => {
      if (endpoint === "/user") {
        if (pause) {
          started?.();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { id: 1 };
      }
      if (endpoint === "/repos/example/app") return { id: 2, full_name: "example/app" };
      return { number: 4, state: "open", merged: pause };
    },
  });
  try {
    const saved = (await service.api(
      "wake.save",
      { input: { ...f.input, condition: { kind: "pr", repository: "example/app", number: 4 } } },
      "save-race",
    )) as Wake;
    await service.tick();
    pause = true;
    const checking = service.tick();
    await began;
    const current = f.store.record("wake", saved.id);
    await service.api("wake.cancel", { id: saved.id, revision: current?.revision }, "cancel-race");
    release?.();
    await checking;
    expect(f.store.record("wake", saved.id)?.status).toBe("cancelled");
    expect(f.store.snapshot(["item"]).item ?? []).toEqual([]);
  } finally {
    release?.();
    await service.close();
    f.close();
  }
});

it("natural-language proposals stay drafts until the person saves them", async () => {
  const f = await fixture();
  const { wakeTools } = await import("./wake-tools.js");
  const { PrivateInputGuard } = await import("./private-input.js");
  const tool = wakeTools({
    store: f.store,
    publish() {},
    privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
    wake: async () => {},
    interrupt: async () => {},
    answer: async () => ({}),
  } as unknown as Parameters<typeof wakeTools>[0]);
  try {
    const call = {
      actor: { threadId: "thread", agentId: "profile", sessionId: "session", turnId: "turn" },
      arguments: {
        action: "prepare",
        key: "tests-done",
        input: { ...f.input, fallbackAt: new Date(Date.now() + 86400000).toISOString() },
      },
    } as Parameters<ReturnType<typeof wakeTools>>[0];
    await tool(call);
    await tool(call);
    const proposals = f.store.snapshot(["wake"]).wake ?? [];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe("draft");
    expect(f.store.record("thread", "thread")?.wakePending).not.toBe(true);
    expect(f.store.snapshot(["item"]).item ?? []).toEqual([]);
  } finally {
    f.close();
  }
});
