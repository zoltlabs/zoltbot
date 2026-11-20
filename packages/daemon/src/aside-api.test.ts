import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { ForkFakeSession } from "../../../tools/fakes/src/fork-runtime.js";
import { at } from "../../../tools/fakes/src/runtime-fixture.js";
import { asideApi, asideTitle } from "./aside-api.js";
import { PrivateInputGuard } from "./private-input.js";
import { runtimeApi } from "./runtime-api.js";
import { SessionManager } from "./session-manager.js";

async function fixture() {
  const f = await forkFixture();
  const natives: ForkFakeSession[] = [];
  const requests: { mode: string; permission: string }[] = [];
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const manager = new SessionManager({
    privacy,
    store: f.store,
    publish() {},
    host: {
      async prepare(input) {
        return {
          cwd: f.root,
          estimate: () => 1,
          configuration: { version: 1, profile: input.profile },
          async open(request) {
            requests.push({ mode: request.mode, permission: input.profile.permissionProfile });
            const native = new ForkFakeSession(request.nativeId ?? crypto.randomUUID());
            natives.push(native);
            return native;
          },
        };
      },
    },
  });
  const runtime = runtimeApi({ store: f.store, manager, publish() {} });
  let failSend = false;
  const api = asideApi({
    store: f.store,
    privacy,
    publish() {},
    send: (method, params, id) => {
      if (failSend) throw Error("runtime_unavailable");
      return runtime(method, params, id);
    },
  });
  return {
    ...f,
    api,
    failNextSends: (value: boolean) => {
      failSend = value;
    },
    manager,
    natives,
    requests,
    async clean() {
      await manager.close();
      f.close();
    },
  };
}

it("answers a side question in a read-only copy while the chat's turn keeps running", async () => {
  const f = await fixture();
  try {
    f.put("session", { ...f.store.record("session", "session"), state: "running" });
    f.put("turn", {
      id: "running-turn",
      threadId: "thread",
      sessionId: "session",
      status: "running",
      origin: "human",
      startedAt: at,
    });
    const before = {
      items: f.store.snapshot(["item"]).item?.filter((r) => r.threadId === "thread"),
      turns: f.store.snapshot(["turn"]).turn?.filter((r) => r.threadId === "thread"),
      session: f.store.record("session", "session"),
    };
    const params = { threadId: "thread", text: "Which file is that in?" };
    const [one, two] = (await Promise.all([
      f.api("turn.aside", params, "aside-1"),
      f.api("turn.aside", params, "aside-1"),
    ])) as { threadId: string }[];
    if (!one) throw Error("missing_aside");
    expect(two).toEqual(one);
    expect(f.store.record("thread", one.threadId)).toMatchObject({
      kind: "aside",
      title: "Which file is that in?",
      fork: { kind: "copied", sourceThreadId: "thread", permissionCeiling: "read_only" },
    });
    // The daemon wakes workers when events publish; this fixture publishes nowhere, so poll.
    await expect
      .poll(async () => {
        (await f.manager.ensure(one.threadId)).wake();
        return f.natives[0]?.received.length;
      })
      .toBe(1);
    expect(f.requests[0]).toEqual({ mode: "new", permission: "read_only" });
    const sent = JSON.stringify(f.natives[0]?.received[0]);
    expect(sent).toContain("SOURCE_ONLY");
    expect(sent).toContain("Which file is that in?");
    // The chat itself is untouched: same items, same turns, same session.
    expect(f.store.snapshot(["item"]).item?.filter((r) => r.threadId === "thread")).toEqual(
      before.items,
    );
    expect(f.store.snapshot(["turn"]).turn?.filter((r) => r.threadId === "thread")).toEqual(
      before.turns,
    );
    expect(f.store.record("session", "session")).toEqual(before.session);
    expect(await f.api("turn.aside", params, "aside-1")).toEqual(one);
    await expect(
      f.api("turn.aside", { ...params, text: "Something else" }, "aside-1"),
    ).rejects.toThrow("command_receipt_conflict");
  } finally {
    await f.clean();
  }
});

it("refuses asides of asides and chats with nothing to copy", async () => {
  const f = await fixture();
  try {
    const aside = (await f.api("turn.aside", { threadId: "thread", text: "Why?" }, "a")) as {
      threadId: string;
    };
    await expect(
      f.api("turn.aside", { threadId: aside.threadId, text: "And?" }, "b"),
    ).rejects.toThrow("aside_unavailable");
    f.put("item", { ...f.store.record("item", "source-message"), body: { text: "" } });
    await expect(f.api("turn.aside", { threadId: "thread", text: "Why?" }, "c")).rejects.toThrow(
      "aside_unavailable",
    );
    await expect(f.api("turn.aside", { threadId: "thread", text: " " }, "d")).rejects.toThrow(
      "aside_text_required",
    );
  } finally {
    await f.clean();
  }
});

it("titles an aside with the question's first line", () => {
  expect(asideTitle("Where is it?\nMore detail")).toBe("Where is it?");
  expect(asideTitle("x".repeat(80))).toHaveLength(60);
});

it("continues an aside as a normal chat", async () => {
  const f = await fixture();
  try {
    const aside = (await f.api("turn.aside", { threadId: "thread", text: "Why?" }, "a")) as {
      threadId: string;
    };
    expect(await f.api("thread.continueAside", { id: aside.threadId }, "keep")).toMatchObject({
      id: aside.threadId,
      kind: "side",
      fork: { permissionCeiling: "read_only" },
    });
    expect(await f.api("thread.continueAside", { id: aside.threadId }, "keep")).toMatchObject({
      kind: "side",
    });
  } finally {
    await f.clean();
  }
});

it("asks on retry when the first attempt made the aside but failed to ask", async () => {
  const f = await fixture();
  try {
    f.failNextSends(true);
    const params = { threadId: "thread", text: "Where?" };
    await expect(f.api("turn.aside", params, "retry")).rejects.toThrow("runtime_unavailable");
    f.failNextSends(false);
    const aside = (await f.api("turn.aside", params, "retry")) as { threadId: string };
    const asked = () =>
      f.store
        .snapshot(["item"])
        .item?.filter((r) => r.threadId === aside.threadId && r.kind === "user");
    expect(asked()).toHaveLength(1);
    await f.api("turn.aside", params, "retry");
    expect(asked()).toHaveLength(1);
  } finally {
    await f.clean();
  }
});
