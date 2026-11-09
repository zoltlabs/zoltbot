import { readFileSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import type { InteractionAnswer } from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import { interactionApi } from "./interaction-api.js";
import { InteractionEngine } from "./interaction-engine.js";
import { at, draft, fixture, human } from "./interaction-test-fixture.js";
import { Logger } from "./logging.js";
import { Supervisor } from "./supervisor.js";

it.each([
  "decline",
  "cancel",
] as const)("permits %s without protected storage when no private value is submitted", async (action) => {
  const test = await fixture();
  try {
    test.host.persistPrivateContext = async () => {
      throw new Error("unexpected_storage_call");
    };
    const result = await test.engine.answer(
      "question",
      1,
      { action, by: human, at },
      `answer:${action}`,
      human,
    );
    expect(result.state).toBe("answered");
    expect(test.replies[0]?.action).toBe(action);
  } finally {
    test.close();
  }
});

it("waits for protected context acknowledgement before saving or delivering a private answer", async () => {
  const test = await fixture();
  let saved = false,
    entered = false;
  let release: () => void = () => {};
  test.host.persistPrivateContext = async () => {
    entered = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    saved = true;
  };
  const respond = test.host.respond;
  test.host.respond = async (request, answer) => {
    expect(saved).toBe(true);
    await respond(request, answer);
  };
  try {
    const work = test.engine.answer(
      "question",
      1,
      {
        action: "accept",
        answers: { q: { value: "synthetic-private-durable-answer" } },
        by: human,
        at,
      },
      "answer:protected",
      human,
    );
    expect(entered).toBe(true);
    expect(test.store.snapshot().interaction?.[0]?.state).toBe("pending");
    expect(test.replies).toEqual([]);
    release();
    await work;
    expect(test.replies).toHaveLength(1);
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-private-durable-answer");
  } finally {
    release();
    test.close();
  }
});

it("preserves a pending request without native delivery when protected context storage fails", async () => {
  const test = await fixture();
  test.host.persistPrivateContext = async () => {
    throw new Error("synthetic-private-storage-failure");
  };
  try {
    await expect(
      test.engine.answer(
        "question",
        1,
        {
          action: "accept",
          answers: { q: { value: "synthetic-private-durable-answer" } },
          by: human,
          at,
        },
        "answer:failed-protection",
        human,
      ),
    ).rejects.toThrow(/^secret_storage_failed$/);
    expect(test.store.snapshot().interaction?.[0]?.state).toBe("pending");
    expect(test.store.receipt("answer:failed-protection")).toBeUndefined();
    expect(test.replies).toEqual([]);
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-private-durable-answer");
    expect(JSON.stringify(test.store.snapshot())).not.toContain(
      "synthetic-private-storage-failure",
    );
  } finally {
    test.close();
  }
});

it("persists a masked answer before replying and does not reply twice on command replay", async () => {
  const test = await fixture();
  try {
    const secret = "synthetic-private-runtime-answer";
    const answer: InteractionAnswer = {
      action: "accept",
      answers: { q: { value: secret } },
      by: human,
      at,
    };
    test.host.respond = async (_interaction, value) => {
      expect(test.store.snapshot().interaction?.[0]?.state).toBe("answered");
      expect(test.frames.text(secret)).toBe("[redacted]");
      test.replies.push(value);
    };
    const first = await test.engine.answer("question", 1, answer, "answer", human);
    expect(await test.engine.answer("question", 1, answer, "answer", human)).toEqual(first);
    expect(test.replies).toHaveLength(1);
    expect(test.replies[0]?.answers?.q?.value).toBe(secret);
    expect(JSON.stringify(test.store.snapshot())).not.toContain(secret);
    expect(JSON.stringify(test.events)).not.toContain(secret);
  } finally {
    test.close();
  }
});
it("keeps an undeliverable answer durable and records a generic timeline warning", async () => {
  const test = await fixture();
  try {
    test.host.respond = async () => {
      throw new Error("private-provider-error");
    };
    const answer: InteractionAnswer = { action: "cancel", by: human, at };
    expect(await test.engine.answer("question", 1, answer, "answer", human)).toMatchObject({
      state: "answered",
    });
    expect(JSON.stringify(test.store.snapshot())).toContain("interaction_reply_failed");
    expect(JSON.stringify(test.store.snapshot())).not.toContain("private-provider-error");
  } finally {
    test.close();
  }
});
it("requires protected storage for secrets that do not belong in a native reply", async () => {
  const test = await fixture();
  try {
    test.host.requiresSecretReply = () => false;
    const answer: InteractionAnswer = {
      action: "accept",
      answers: { q: { value: "private" } },
      by: human,
      at,
    };
    await expect(test.engine.answer("question", 1, answer, "answer", human)).rejects.toThrow(
      "secret_storage_unavailable",
    );
    expect(test.store.snapshot().interaction?.[0]?.state).toBe("pending");
    expect(test.replies).toEqual([]);
  } finally {
    test.close();
  }
});
it("orders deferred inbox cards last and invalidates cursors when the order changes", async () => {
  const test = await fixture();
  try {
    test.engine.request({ ...draft, id: "second" }, "request-second");
    const api = interactionApi({
      engine: test.engine,
      snapshot: () => test.store.snapshot(),
      seq: () => test.store.lastSeq(),
    });
    const page = (await api("interaction.list", { limit: 1 })) as {
      items: { id: string }[];
      cursor: string;
    };
    expect(page.items[0]?.id).toBe("question");
    await api("interaction.defer", { id: "question" }, "defer");
    expect(await api("interaction.list", {})).toMatchObject({
      items: [{ id: "second" }, { id: "question" }],
    });
    await expect(api("interaction.list", { cursor: page.cursor })).rejects.toThrow(
      "interaction_cursor_stale",
    );
    expect(
      test.store
        .snapshot()
        .interaction?.every((row) => row.state === "pending" && row.version === 1),
    ).toBe(true);
    expect(test.replies).toEqual([]);
  } finally {
    test.close();
  }
});
it("keeps a request pending when no runtime host is configured", async () => {
  const test = await fixture();
  try {
    const engine = new InteractionEngine({ store: test.store, publish() {} });
    await expect(
      engine.answer("question", 1, { action: "cancel", by: human, at }, "answer", human),
    ).rejects.toThrow("interaction_runtime_unavailable");
    expect(test.store.snapshot().interaction?.[0]?.state).toBe("pending");
  } finally {
    test.close();
  }
});
it("delivers a due safe default once and stops the runtime before parking an unsafe request", async () => {
  const test = await fixture();
  try {
    test.engine.request(
      {
        ...draft,
        id: "timed",
        items: [
          { id: "q", prompt: "Choose", options: [{ id: "safe", label: "Safe" }], default: "safe" },
        ],
        timeout: { seconds: 10, onTimeout: "use_default" },
      },
      "request-timed",
    );
    const late = new InteractionEngine({
      store: test.store,
      host: test.host,
      publish() {},
      now: () => "2026-10-27T12:00:11.000Z",
    });
    await late.tick();
    await late.tick();
    expect(test.replies).toHaveLength(1);
    expect(test.replies[0]).toMatchObject({
      automatic: true,
      answers: { q: { options: ["safe"] } },
    });
    test.engine.request(
      { ...draft, id: "parked", timeout: { seconds: 10, onTimeout: "park" } },
      "request-parked",
    );
    await expect(late.tick()).rejects.toThrow("interaction_stop_unavailable");
    expect(test.store.snapshot().interaction?.find((row) => row.id === "parked")?.state).toBe(
      "pending",
    );
    let stopped = false;
    test.host.stopTurn = async (request) => {
      expect(test.store.snapshot().interaction?.find((row) => row.id === request.id)?.state).toBe(
        "pending",
      );
      stopped = true;
    };
    await late.tick();
    expect(stopped).toBe(true);
    expect(test.store.snapshot().interaction?.find((row) => row.id === "parked")?.state).toBe(
      "expired",
    );
  } finally {
    test.close();
  }
});
it("schedules a safe default and withdraws the timer cleanly", async () => {
  const test = await fixture();
  test.host.stopTurn = async () => {};
  const engine = new InteractionEngine({ store: test.store, host: test.host, publish() {} });
  try {
    test.engine.request(
      {
        ...draft,
        id: "scheduled",
        items: [
          { id: "q", prompt: "Choose", options: [{ id: "safe", label: "Safe" }], default: "safe" },
        ],
        timeout: { seconds: 10, onTimeout: "use_default" },
      },
      "request-scheduled",
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(at));
    engine.startTimers();
    await vi.advanceTimersByTimeAsync(9999);
    expect(test.replies).toEqual([]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(test.replies).toHaveLength(1);
    await engine.stopTimers();
    await vi.advanceTimersByTimeAsync(10000);
    expect(test.replies).toHaveLength(1);
  } finally {
    await engine.stopTimers();
    vi.useRealTimers();
    test.close();
  }
});
it("does not let one failed stop prevent another due request from being answered", async () => {
  const test = await fixture();
  try {
    test.host.stopTurn = async () => {
      throw new Error("private-stop-error");
    };
    test.engine.request(
      { ...draft, id: "bad", timeout: { seconds: 10, onTimeout: "park" } },
      "request-bad",
    );
    test.engine.request(
      {
        ...draft,
        id: "good",
        items: [
          { id: "q", prompt: "Choose", options: [{ id: "safe", label: "Safe" }], default: "safe" },
        ],
        timeout: { seconds: 10, onTimeout: "use_default" },
      },
      "request-good",
    );
    const late = new InteractionEngine({
      store: test.store,
      host: test.host,
      publish() {},
      now: () => "2026-10-27T12:00:11.000Z",
    });
    await expect(late.tick()).rejects.toThrow("interaction_stop_failed");
    expect(test.replies).toHaveLength(1);
    expect(test.store.snapshot().interaction?.find((row) => row.id === "bad")?.state).toBe(
      "pending",
    );
    expect(test.store.snapshot().interaction?.find((row) => row.id === "good")?.state).toBe(
      "answered",
    );
  } finally {
    test.close();
  }
});
it("validates secret form input before substituting a protected delivery reference", async () => {
  const test = await fixture();
  try {
    test.engine.request(
      {
        ...draft,
        id: "secret-form",
        type: "form",
        items: [
          {
            id: "f",
            prompt: "Private details",
            secret: true,
            schema: {
              type: "object",
              properties: { code: { type: "string" } },
              required: ["code"],
            },
          },
        ],
      },
      "request-secret-form",
    );
    test.host.requiresSecretReply = () => false;
    test.host.saveSecret = async () => ({ reference: "keychain:fixture-reference" });
    const answer: InteractionAnswer = {
      action: "accept",
      answers: { f: { value: { code: "synthetic-form-private" } } },
      by: human,
      at,
    };
    expect(await test.engine.answer("secret-form", 1, answer, "answer-form", human)).toMatchObject({
      state: "answered",
    });
    expect(test.replies[0]?.answers?.f?.value).toBe("keychain:fixture-reference");
    expect(JSON.stringify(test.store.snapshot())).not.toContain("synthetic-form-private");
  } finally {
    test.close();
  }
});
it("registers numeric private values before a native frame can be recorded", async () => {
  const test = await fixture();
  try {
    await test.engine.answer(
      "question",
      1,
      { action: "accept", answers: { q: { value: 127169 } }, by: human, at },
      "answer-number",
      human,
    );
    expect(test.frames.text(JSON.stringify(test.replies))).not.toContain("127169");
    expect(JSON.stringify(test.store.snapshot())).not.toContain("127169");
  } finally {
    test.close();
  }
});
it("keeps private text and numbers out of real stdin and stdout frame logs", async () => {
  const test = await fixture();
  const frameFile = path.join(test.root, "frames.jsonl");
  const supervisor = new Supervisor(
    {
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      cwd: test.root,
      env: { HOME: test.root, TMPDIR: test.root },
      frameFile,
    },
    new Logger(path.join(test.root, "runtime.log"), test.frames),
  );
  try {
    supervisor.start();
    test.host.respond = async (_request, answer) => {
      await supervisor.writeAsync(JSON.stringify(answer));
    };
    await test.engine.answer(
      "question",
      1,
      {
        action: "accept",
        answers: { q: { value: "synthetic-private-frame-value" } },
        by: human,
        at,
      },
      "answer-frame",
      human,
    );
    test.engine.request({ ...draft, id: "numeric" }, "request-numeric");
    await test.engine.answer(
      "numeric",
      1,
      { action: "accept", answers: { q: { value: 127169 } }, by: human, at },
      "answer-frame-number",
      human,
    );
    await expect
      .poll(
        () =>
          readFileSync(frameFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((frame) => frame.direction === "stdout").length,
      )
      .toBe(2);
    const frames = readFileSync(frameFile, "utf8");
    expect(frames).not.toContain("synthetic-private-frame-value");
    expect(frames).not.toContain("127169");
    expect(frames).toContain("[redacted]");
    for (const line of frames.trim().split("\n"))
      expect(() => JSON.parse(JSON.parse(line).line)).not.toThrow();
  } finally {
    await supervisor.close();
    test.close();
  }
});
it("durably queues a late message once, audits it, and never replies to the expired native request", async () => {
  const test = await fixture();
  try {
    test.engine.request(
      { ...draft, id: "public-question", items: [{ id: "q", prompt: "Choose" }] },
      "public-request",
    );
    test.engine.clear(["thread"], "process_died", "clear");
    const api = interactionApi({
      engine: test.engine,
      snapshot: () => test.store.snapshot(),
      seq: () => test.store.lastSeq(),
    });
    const params = {
      id: "public-question",
      version: 2,
      text: "  Preserve my complete reply\nexactly.  ",
      confirmed: true,
    };
    const first = await api("interaction.forwardLate", params, "late-message");
    expect(await api("interaction.forwardLate", params, "late-message")).toEqual(first);
    expect(test.replies).toHaveLength(0);
    const snapshot = test.store.snapshot();
    const queued = snapshot.item?.filter((item) => item.kind === "user");
    expect(queued).toHaveLength(1);
    expect(test.queuedThreads).toEqual(["thread"]);
    expect(queued?.[0]?.body).toMatchObject({
      input: [{ type: "text", text: params.text }],
      queueState: "queued",
    });
    expect(snapshot.audit?.filter((row) => row.action === "interaction.forwardLate")).toHaveLength(
      1,
    );
    expect(snapshot.interaction?.every((row) => row.state === "expired")).toBe(true);
    test.store.rebuild();
    expect(test.store.snapshot()).toEqual(snapshot);
    await expect(
      api("interaction.forwardLate", { ...params, id: "question" }, "private-late"),
    ).rejects.toThrow("secret_late_forward_forbidden");
    expect(test.store.receipt("private-late")).toBeUndefined();
  } finally {
    test.close();
  }
});
it("auto answers current rules once and stops approving after live revocation", async () => {
  const test = await fixture();
  try {
    const rule = {
      id: "allow-status",
      scope: "global",
      matcher: { tool: "Bash", command: { prefix: ["git", "status"] } },
      decision: "allow",
      createdBy: human,
      createdAt: at,
    };
    test.store.dispatch("create-rule", (state) =>
      handle(
        state,
        { type: "create", kind: "rule", value: rule, confirmed: true },
        { commandId: "create-rule", at, actor: human },
      ),
    );
    const approval = {
      ...draft,
      id: "approval",
      type: "approval",
      context: { toolName: "Bash", command: "git status" },
      items: [
        { id: "a", prompt: "Allow?", choices: [{ id: "allow_once" }, { id: "reject_once" }] },
      ],
    };
    test.engine.request(approval, "approval-request");
    await expect.poll(() => test.replies.length).toBe(1);
    expect(test.store.snapshot().interaction?.find((row) => row.id === "approval")).toMatchObject({
      state: "answered",
      resolution: { automatic: true },
    });
    expect(
      test.store.snapshot().audit?.find((row) => row.action === "interaction.answer"),
    ).toMatchObject({ detail: { ruleId: "allow-status" } });
    test.engine.request(approval, "approval-request");
    expect(test.replies).toHaveLength(1);
    test.store.dispatch("revoke-rule", (state) =>
      handle(
        state,
        { type: "update", kind: "rule", id: rule.id, changes: { revokedAt: at }, confirmed: true },
        { commandId: "revoke-rule", at, actor: human },
      ),
    );
    test.engine.request({ ...approval, id: "next-approval" }, "next-request");
    await test.engine.stopTimers();
    expect(test.replies).toHaveLength(1);
    expect(
      test.store.snapshot().interaction?.find((row) => row.id === "next-approval")?.state,
    ).toBe("pending");
  } finally {
    await test.engine.stopTimers();
    test.close();
  }
});
it("clears only the named native requests and preserves unrelated pending cards", async () => {
  const test = await fixture();
  try {
    test.engine.request({ ...draft, id: "another", nativeRef: "native-other" }, "request:another");
    test.engine.clearRequests(["question"], "provider_cleared", "clear:selected");
    expect(test.store.snapshot().interaction?.find((row) => row.id === "question")?.state).toBe(
      "expired",
    );
    expect(test.store.snapshot().interaction?.find((row) => row.id === "another")?.state).toBe(
      "pending",
    );
  } finally {
    await test.engine.stopTimers();
    test.close();
  }
});
it("holds active private answer work against provider clear until the answer transaction commits", async () => {
  const test = await fixture();
  let save: (value: { reference: string }) => void = () => {},
    entered = false;
  test.host.requiresSecretReply = () => false;
  test.host.saveSecret = async () => {
    entered = true;
    return new Promise((resolve) => {
      save = resolve;
    });
  };
  try {
    const answering = test.engine.answer(
      "question",
      1,
      { action: "accept", answers: { q: { value: "synthetic-private-answer" } }, by: human, at },
      "answer:held",
      human,
    );
    while (!entered) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(test.engine.heldRequestIds()).toContain("question");
    test.engine.clearRequests(["question"], "provider_cleared", "clear:held");
    expect(test.store.snapshot().interaction?.[0]?.state).toBe("pending");
    save({ reference: "keychain:fixture" });
    await answering;
    expect(test.engine.heldRequestIds()).toEqual([]);
    expect(test.store.snapshot().interaction?.[0]?.state).toBe("answered");
  } finally {
    save({ reference: "keychain:fixture" });
    await test.engine.stopTimers();
    test.close();
  }
});
it("waits for an in flight native answer before shutdown releases the store", async () => {
  const test = await fixture();
  let finish: () => void = () => {},
    entered = false,
    drained = false;
  test.host.respond = async () => {
    entered = true;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  };
  const answering = test.engine.answer(
    "question",
    1,
    { action: "accept", answers: { q: { value: "synthetic-private-shutdown" } }, by: human, at },
    "answer:shutdown",
    human,
  );
  try {
    while (!entered) await new Promise<void>((resolve) => setImmediate(resolve));
    const stopping = test.engine.stopTimers().then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    finish();
    await answering;
    await stopping;
    expect(drained).toBe(true);
  } finally {
    finish();
    await answering;
    await test.engine.stopTimers();
    test.close();
  }
});
