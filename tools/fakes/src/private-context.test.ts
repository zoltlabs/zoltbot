import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { handle, queueHumanInput } from "@zoltbot/core";
import { expect, it, vi } from "vitest";
import { InteractionEngine } from "../../../packages/daemon/src/interaction-engine.js";
import { runtimeApi } from "../../../packages/daemon/src/runtime-api.js";
import { KeychainSecrets } from "../../../packages/daemon/src/secrets.js";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { ReferenceSession } from "./reference-adapter.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

const secret = "synthetic-private-resume-answer";
const secondSecret = "synthetic-private-second-answer";
async function until(check: () => boolean) {
  for (let count = 0; count < 300; count++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture_deadline");
}
it("registers configured private values before an asynchronous native open can accept public input", async () => {
  const fixture = await runtimeFixture();
  fixture.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  let entered: () => void = () => {},
    release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const manager = new SessionManager({
    store: fixture.store,
    publish() {},
    host: {
      async prepare(_input, redactor) {
        return {
          cwd: fixture.root,
          estimate: (text) => text.length,
          privateValues: [secret],
          async open(request) {
            entered();
            await gate;
            return new ReferenceSession(
              {
                identity: { agentId: "profile", threadId: "thread" },
                mode: request.mode,
                ...(request.nativeId ? { nativeId: request.nativeId } : {}),
                cwd: fixture.root,
                permissionProfile: "read_only",
                hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
              },
              undefined,
              1500,
              redactor,
            ).open();
          },
        };
      },
    },
  });
  const opening = manager.ensure("thread");
  try {
    await started;
    await expect(manager.prepareInput([{ type: "text", text: secret }])).rejects.toThrow(
      "private_value_requires_secure_field",
    );
  } finally {
    release();
    await opening;
    await manager.close();
    fixture.close();
  }
});

it("restores protected redaction before native resume and keeps private answers out of every durable channel", async () => {
  const fixture = await runtimeFixture(),
    values = new Map<string, string>();
  let readFailed = false,
    prepares = 0;
  let pausePut = false,
    enteredPut: () => void = () => {},
    releasePut: () => void = () => {};
  const vault = new KeychainSecrets(async (request) => {
    if (request.op === "put") {
      if (pausePut) {
        pausePut = false;
        enteredPut();
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
      }
      values.set(request.account, request.value ?? "");
      return { ok: true };
    }
    if (readFailed) throw new Error("synthetic-private-vault-error");
    return { ok: true, value: values.get(request.account) };
  });
  fixture.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor: { kind: "system", id: "runtime" } },
    ),
  );
  let opens = 0,
    restoredBeforePrepare = false,
    restoredSecond = false;
  const create = () => {
    let engine: InteractionEngine;
    const manager = new SessionManager({
      store: fixture.store,
      publish() {},
      secrets: vault,
      interactions: async () => engine,
      host: {
        async prepare(input, redactor) {
          prepares++;
          if (input.previous?.privateContextRequired) {
            restoredBeforePrepare = redactor.hidesFrames && redactor.text(secret) === "[redacted]";
            if (values.size > 1) restoredSecond = redactor.text(secondSecret) === "[redacted]";
          }
          return {
            cwd: fixture.root,
            estimate: (text) => text.length,
            async open(request) {
              opens++;
              return new ReferenceSession(
                {
                  identity: { agentId: "profile", threadId: "thread" },
                  mode: request.mode,
                  ...(request.nativeId ? { nativeId: request.nativeId } : {}),
                  cwd: fixture.root,
                  permissionProfile: "read_only",
                  hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
                },
                undefined,
                1500,
                redactor,
              ).open();
            },
          };
        },
      },
    });
    engine = new InteractionEngine({
      store: fixture.store,
      publish() {},
      host: manager.interactionHost,
    });
    return { manager, engine };
  };
  let runtime = create();
  const rejectsPublicCopy = async (
    manager: SessionManager,
    threadId: string,
    commandId: string,
  ) => {
    const before = fixture.store.lastSeq(),
      api = runtimeApi({ store: fixture.store, manager, publish() {} });
    await expect(
      Promise.resolve(
        api(
          "turn.send",
          { threadId, mode: "queue", input: [{ type: "text", text: `Do not persist ${secret}` }] },
          commandId,
        ),
      ),
    ).rejects.toThrow("private_value_requires_secure_field");
    expect(fixture.store.lastSeq()).toBe(before);
    expect(fixture.store.receipt(commandId)).toBeUndefined();
  };
  try {
    const worker = await runtime.manager.ensure("thread");
    fixture.queue("private-request", "secret_question");
    worker.wake();
    await until(
      () => fixture.store.snapshot().interaction?.some((row) => row.state === "pending") ?? false,
    );
    const request = fixture.store.snapshot().interaction?.find((row) => row.state === "pending");
    if (!request) throw new Error("fixture_request_missing");
    await runtime.engine.answer(
      String(request.id),
      Number(request.version),
      {
        action: "accept",
        answers: { private: { value: secret } },
        by: { kind: "human", id: "owner" },
        at,
      },
      "private-answer",
      { kind: "human", id: "owner" },
    );
    await until(
      () => fixture.store.snapshot().turn?.some((row) => row.status === "completed") ?? false,
    );
    await rejectsPublicCopy(runtime.manager, "thread", "reject-live-private-copy");
    runtime.engine.request(
      {
        id: "late-private-copy",
        agentId: "profile",
        threadId: "thread",
        type: "question",
        items: [{ id: "q", prompt: "Late note", allowOther: true }],
        chain: [],
        urgency: "blocking",
      },
      "request-late-copy",
    );
    runtime.engine.clearRequests(["late-private-copy"], "provider_cleared", "expire-late-copy");
    const beforeLate = fixture.store.lastSeq();
    await expect(
      Promise.resolve().then(() =>
        runtime.engine.forwardLate(
          { id: "late-private-copy", version: 2, text: secret, confirmed: true },
          "reject-late-private-copy",
          { kind: "human", id: "owner" },
        ),
      ),
    ).rejects.toThrow("private_value_requires_secure_field");
    expect(fixture.store.lastSeq()).toBe(beforeLate);
    await runtime.manager.close();
    expect(values.size).toBeGreaterThan(0);
    expect(JSON.stringify(fixture.store.snapshot())).not.toContain(secret);
    fixture.store.rebuild();
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2000-01-01T00:00:00.000Z");
    runtime = create();
    fixture.store.dispatch("other-thread", (state) =>
      handle(
        state,
        {
          type: "create",
          kind: "thread",
          value: { ...state.thread?.[0], id: "other", title: "Other" },
        },
        { commandId: "other-thread", at, actor: { kind: "human", id: "owner" } },
      ),
    );
    await rejectsPublicCopy(runtime.manager, "other", "reject-restarted-cross-thread-copy");
    expect(opens).toBe(1);
    const resumed = await runtime.manager.ensure("thread");
    expect(restoredBeforePrepare).toBe(true);
    fixture.queue("echo-private", "private_echo");
    resumed.wake();
    await until(
      () => fixture.store.snapshot().turn?.filter((row) => row.status === "completed").length === 2,
    );
    expect(
      fixture.store
        .snapshot()
        .item?.some(
          (row) => (row.body as Record<string, unknown>).text === "Private echo: [redacted]",
        ),
    ).toBe(true);
    const raceInput = [{ type: "text" as const, text: `Do not store ${secondSecret}` }];
    const validateRace = await runtime.manager.prepareInput(raceInput);
    fixture.queue("second-private-request", "secret_question");
    resumed.wake();
    await until(
      () => fixture.store.snapshot().interaction?.some((row) => row.state === "pending") ?? false,
    );
    const secondRequest = fixture.store
      .snapshot()
      .interaction?.find((row) => row.state === "pending");
    if (!secondRequest) throw new Error("fixture_second_request_missing");
    pausePut = true;
    const entered = new Promise<void>((resolve) => {
      enteredPut = resolve;
    });
    const answering = runtime.engine.answer(
      String(secondRequest.id),
      Number(secondRequest.version),
      {
        action: "accept",
        answers: { private: { value: secondSecret } },
        by: { kind: "human", id: "owner" },
        at,
      },
      "second-private-answer",
      { kind: "human", id: "owner" },
    );
    await entered;
    const beforeRace = fixture.store.lastSeq();
    expect(() =>
      fixture.store.dispatch("reject-private-race", (state) => {
        validateRace(state);
        return queueHumanInput(
          state,
          { threadId: "thread", input: raceInput, mode: "queue" },
          "race-input",
          { commandId: "reject-private-race", at, actor: { kind: "human", id: "owner" } },
        );
      }),
    ).toThrow("private_value_requires_secure_field");
    expect(fixture.store.lastSeq()).toBe(beforeRace);
    expect(fixture.store.receipt("reject-private-race")).toBeUndefined();
    releasePut();
    await answering;
    expect(() => validateRace(fixture.store.snapshot())).toThrow("private_context_changed");
    await until(
      () => fixture.store.snapshot().turn?.filter((row) => row.status === "completed").length === 3,
    );
    await runtime.manager.close();
    fixture.store.rebuild();
    runtime = create();
    const third = await runtime.manager.ensure("thread");
    expect(restoredSecond).toBe(true);
    fixture.queue("echo-both-private", "private_echo_both");
    third.wake();
    await until(
      () => fixture.store.snapshot().turn?.filter((row) => row.status === "completed").length === 4,
    );
    expect(
      fixture.store
        .snapshot()
        .item?.some(
          (row) =>
            (row.body as Record<string, unknown>).text === "Private echo: [redacted] [redacted]",
        ),
    ).toBe(true);
    expect(
      fixture.store
        .snapshot()
        .session?.filter((row) => row.generation !== undefined)
        .map((row) => row.generation)
        .sort(),
    ).toEqual([1, 2, 3]);
    expect(opens).toBe(3);
    await runtime.manager.close();
    readFailed = true;
    const beforePrepare = prepares;
    runtime = create();
    const lockedApi = runtimeApi({ store: fixture.store, manager: runtime.manager, publish() {} }),
      beforeLocked = fixture.store.lastSeq();
    await expect(
      Promise.resolve(
        lockedApi(
          "turn.send",
          {
            threadId: "other",
            mode: "queue",
            input: [{ type: "text", text: "Ordinary safe draft" }],
          },
          "reject-locked-context",
        ),
      ),
    ).rejects.toThrow("runtime_private_context_required");
    expect(fixture.store.lastSeq()).toBe(beforeLocked);
    await expect(runtime.manager.ensure("thread")).rejects.toThrow(
      "runtime_private_context_required",
    );
    expect(prepares).toBe(beforePrepare);
    expect(opens).toBe(3);
    for (const name of [
      "store.db",
      "store.db-wal",
      "frames.jsonl",
      "frames.jsonl.1",
      "adapter.log",
    ]) {
      const file = path.join(fixture.root, name);
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(secret))).toBe(false);
      if (existsSync(file))
        expect(readFileSync(file).includes(Buffer.from(secondSecret))).toBe(false);
    }
  } finally {
    releasePut();
    vi.restoreAllMocks();
    await runtime.manager.close();
    fixture.close();
  }
});
