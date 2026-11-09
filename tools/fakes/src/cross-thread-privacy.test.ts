import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { handle, queueHumanInput } from "@zoltbot/core";
import { expect, it } from "vitest";
import { InteractionEngine } from "../../../packages/daemon/src/interaction-engine.js";
import type { RuntimeStream } from "../../../packages/daemon/src/runtime-worker.js";
import { KeychainSecrets } from "../../../packages/daemon/src/secrets.js";
import { SessionManager } from "../../../packages/daemon/src/session-manager.js";
import { ReferenceSession } from "./reference-adapter.js";
import { at, runtimeFixture } from "./runtime-fixture.js";

async function until(check: () => boolean) {
  for (let count = 0; count < 300; count++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("fixture_deadline");
}
it("redacts private values in another live thread and restores that protection before reopening only the other thread", async () => {
  const fixture = await runtimeFixture(),
    values = new Map<string, string>();
  const actor = { kind: "human" as const, id: "owner" };
  const secrets = ["synthetic-private-resume-answer", "synthetic-private-live-value"];
  const vault = new KeychainSecrets(async (request) => {
    if (request.op === "put") {
      values.set(request.account, request.value ?? "");
      return { ok: true };
    }
    return { ok: true, value: values.get(request.account) };
  });
  fixture.store.dispatch("close-seed", (state) =>
    handle(
      state,
      { type: "transition", kind: "session", id: "session", to: "closed" },
      { commandId: "close-seed", at, actor },
    ),
  );
  fixture.store.dispatch("other", (state) =>
    handle(
      state,
      {
        type: "create",
        kind: "thread",
        value: {
          id: "other",
          agentId: "profile",
          kind: "main",
          title: "Other",
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: at,
          lastActivityAt: at,
        },
      },
      { commandId: "other", at, actor },
    ),
  );
  const natives = new Map<string, ReferenceSession>();
  const streams: RuntimeStream[] = [];
  const create = () => {
    let engine: InteractionEngine;
    const manager = new SessionManager({
      store: fixture.store,
      secrets: vault,
      publish() {},
      stream: (update) => streams.push(structuredClone(update)),
      interactions: async () => engine,
      host: {
        async prepare(input, redactor) {
          const cwd = path.join(fixture.root, input.thread.id);
          mkdirSync(cwd, { recursive: true });
          return {
            cwd,
            estimate: (text) => text.length,
            async open(request) {
              const native = await new ReferenceSession(
                {
                  identity: { agentId: "profile", threadId: input.thread.id },
                  mode: request.mode,
                  ...(request.nativeId ? { nativeId: request.nativeId } : {}),
                  cwd,
                  permissionProfile: "read_only",
                  hostMcp: { url: "http://127.0.0.1:1", token: "fixture-only" },
                },
                undefined,
                15000,
                redactor,
              ).open();
              natives.set(input.thread.id, native);
              return native;
            },
          };
        },
      },
    });
    engine = new InteractionEngine({
      store: fixture.store,
      host: manager.interactionHost,
      publish() {},
    });
    return { manager, engine };
  };
  let runtime = create();
  const send = async (threadId: string, text: string, id: string) => {
    fixture.store.dispatch(id, (state) =>
      queueHumanInput(state, { threadId, input: [{ type: "text", text }], mode: "queue" }, id, {
        commandId: id,
        at,
        actor,
      }),
    );
    (await runtime.manager.ensure(threadId)).wake();
  };
  const completed = (threadId: string, count: number) =>
    until(
      () =>
        (fixture.store.snapshot().turn ?? []).filter(
          (row) => row.threadId === threadId && row.status === "completed",
        ).length >= count,
    );
  try {
    await runtime.manager.ensure("thread");
    await runtime.manager.ensure("other");
    for (const [index, secret] of secrets.entries()) {
      await send("thread", "secret_question", `ask:${index}`);
      await until(
        () => fixture.store.snapshot().interaction?.some((row) => row.state === "pending") ?? false,
      );
      const request = fixture.store.snapshot().interaction?.find((row) => row.state === "pending");
      if (!request) throw new Error("fixture_request_missing");
      await runtime.engine.answer(
        String(request.id),
        Number(request.version),
        { action: "accept", answers: { private: { value: secret } }, by: actor, at },
        `answer:${index}`,
        actor,
      );
      await completed("thread", index + 1);
    }
    await send("other", "private_echo", "echo-live");
    await completed("other", 1);
    expect(JSON.stringify(fixture.store.snapshot())).not.toContain(secrets[0]);
    await send("other", "stream_pause", "split-live");
    await until(() => runtime.manager.streamItems().some((row) => row.threadId === "other"));
    expect(JSON.stringify(runtime.manager.streamItems())).not.toContain("synthetic-private-");
    await natives.get("other")?.advanceStream();
    expect(JSON.stringify(runtime.manager.streamItems())).not.toContain("synthetic-private-");
    await natives.get("other")?.advanceStream();
    await completed("other", 2);
    expect(JSON.stringify(fixture.store.snapshot())).toContain("visible [redacted] done");
    await runtime.manager.close();
    fixture.store.rebuild();
    runtime = create();
    await runtime.manager.ensure("other");
    await send("other", "private_echo", "echo-restored");
    await completed("other", 3);
    expect(JSON.stringify(streams)).not.toContain("synthetic-private-");
    await runtime.manager.close();
    for (const file of [
      "store.db",
      "store.db-wal",
      "thread/frames.jsonl",
      "other/frames.jsonl",
      "thread/adapter.log",
      "other/adapter.log",
    ]) {
      const target = path.join(fixture.root, file);
      if (existsSync(target)) {
        const bytes = readFileSync(target);
        for (const secret of secrets) expect(bytes.includes(Buffer.from(secret))).toBe(false);
        expect(bytes.includes(Buffer.from("synthetic-private-"))).toBe(false);
      }
    }
  } finally {
    await runtime.manager.close();
    fixture.close();
  }
});
