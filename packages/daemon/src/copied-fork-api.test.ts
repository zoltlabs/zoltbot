import { handle } from "@zoltbot/core";
import { type ForkOperation, ProfileSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { forkFixture } from "../../../tools/fakes/src/fork-fixture.js";
import { ForkFakeSession } from "../../../tools/fakes/src/fork-runtime.js";
import { at } from "../../../tools/fakes/src/runtime-fixture.js";
import { copiedContextKey } from "./copied-fork-context.js";
import { forkApi } from "./fork-api.js";
import { PrivateInputGuard } from "./private-input.js";
import { SessionManager } from "./session-manager.js";

async function fixture() {
  const f = await forkFixture();
  f.put("agentDefinition", {
    ...f.store.record("agentDefinition", "fake"),
    id: "other-tool",
    displayName: "Other coding tool",
  });
  f.put("agent", {
    ...f.store.record("agent", "profile"),
    id: "destination",
    name: "Other tool profile",
    definitionId: "other-tool",
    permissionProfile: "full_access",
  });
  const natives: ForkFakeSession[] = [];
  const requests: { mode: string; profile: string; permission: string }[] = [];
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
          firstTurnKnowledge: {
            packId: "destination-knowledge",
            text: "DESTINATION_KNOWLEDGE",
            tokens: 1,
          },
          async open(request) {
            requests.push({
              mode: request.mode,
              profile: input.profile.id,
              permission: input.profile.permissionProfile,
            });
            const native = new ForkFakeSession(request.nativeId ?? crypto.randomUUID());
            natives.push(native);
            return native;
          },
        };
      },
    },
  });
  const api = forkApi({ store: f.store, manager, privacy, publish() {} });
  async function send(threadId: string, id: string) {
    const worker = await manager.ensure(threadId);
    f.store.dispatch(id, (s) =>
      handle(
        s,
        {
          type: "create",
          kind: "item",
          value: {
            id,
            threadId,
            kind: "user",
            seq: 10 + (natives[0]?.received.length ?? 0),
            body: {
              input: [{ type: "text", text: id }],
              mode: "queue",
              origin: "human",
              queueState: "queued",
            },
            createdAt: at,
            updatedAt: at,
          },
        },
        { commandId: id, at, actor: { kind: "human", id: "owner" } },
      ),
    );
    await worker.wake();
    await expect.poll(() => f.store.record("item", id)?.turnId).toBeTruthy();
    await expect
      .poll(() =>
        f.store
          .snapshot(["turn"])
          .turn?.some((t) => t.threadId === threadId && t.status === "running"),
      )
      .toBe(false);
  }
  return {
    ...f,
    manager,
    privacy,
    api,
    natives,
    requests,
    send,
    async clean() {
      await manager.close();
      f.close();
    },
  };
}
it("copies across tools into a fresh session, with source permission ceiling and reference text once", async () => {
  const f = await fixture();
  try {
    f.put("item", { ...f.store.record("item", "source-message"), seq: 2 });
    f.put("item", {
      id: "source-user",
      threadId: "thread",
      seq: 1,
      kind: "user",
      body: {
        input: [
          { type: "text", text: "OLD_REQUEST" },
          { type: "file", path: "/private/attachment" },
        ],
      },
      createdAt: at,
    });
    f.put("item", {
      id: "source-tool",
      threadId: "thread",
      seq: 3,
      kind: "tool",
      body: { text: "TOOL_OUTPUT_MUST_NOT_COPY" },
      createdAt: at,
    });
    const params = {
      id: "thread",
      destinationProfileId: "destination",
      title: "Cross-tool child",
      kind: "copied",
    };
    expect(await f.api("thread.forkPreview", params)).toMatchObject({
      available: true,
      kind: "copied",
      copiedMessages: 2,
    });
    const [one, two] = (await Promise.all([
      f.api("thread.fork", params, "copy"),
      f.api("thread.fork", params, "copy"),
    ])) as ForkOperation[];
    if (!one) throw Error("missing_copy");
    expect(two).toEqual(one);
    expect(f.requests).toEqual([]);
    expect(f.store.record("thread", one.childThreadId)).toMatchObject({
      agentId: "destination",
      kind: "side",
      fork: { kind: "copied", inheritedHistoryPresent: false, permissionCeiling: "read_only" },
    });
    await f.send(one.childThreadId, "NEW_INSTRUCTION");
    expect(f.requests[0]).toEqual({ mode: "new", profile: "destination", permission: "read_only" });
    const sent = JSON.stringify(f.natives[0]?.received[0]);
    expect(sent).toContain("quoted historical data");
    expect(sent).toContain("OLD_REQUEST");
    expect(sent).toContain("SOURCE_ONLY");
    expect(sent).toContain("NEW_INSTRUCTION");
    expect(sent).toContain("DESTINATION_KNOWLEDGE");
    expect(sent).not.toContain("TOOL_OUTPUT_MUST_NOT_COPY");
    expect(sent).not.toContain("/private/attachment");
    await f.manager.stopSession(
      String(
        f.store.snapshot(["session"]).session?.find((s) => s.threadId === one.childThreadId)?.id,
      ),
    );
    await f.send(one.childThreadId, "SECOND_INSTRUCTION");
    expect(f.requests[1]?.mode).toBe("resume");
    expect(JSON.stringify(f.natives[1]?.received)).not.toContain("SOURCE_ONLY");
    expect(await f.api("thread.fork", params, "copy")).toEqual(one);
    await expect(f.api("thread.fork", { ...params, title: "Changed" }, "copy")).rejects.toThrow(
      "command_receipt_conflict",
    );
  } finally {
    await f.clean();
  }
});
it("automatically copies unsupported tools and preserves copied history across another fork", async () => {
  const f = await fixture();
  try {
    f.put("session", { ...f.store.record("session", "session"), capabilities: {} });
    expect(await f.api("thread.forkPreview", { id: "thread" })).toMatchObject({
      available: true,
      kind: "copied",
    });
    await expect(
      f.api("thread.fork", { id: "thread", kind: "native" }, "force-native"),
    ).rejects.toThrow("native_fork_unverified");
    const child = (await f.api("thread.fork", { id: "thread" }, "copy")) as ForkOperation;
    await f.send(child.childThreadId, "CONTINUE_CHILD");
    const next = (await f.api(
      "thread.fork",
      { id: child.childThreadId, kind: "copied" },
      "copy-again",
    )) as ForkOperation;
    expect(
      JSON.stringify(f.store.record("settings", copiedContextKey(next.childThreadId))),
    ).toContain("SOURCE_ONLY");
  } finally {
    await f.clean();
  }
});
it("rejects known private history before storing a copy and discloses bounded recent history", async () => {
  const f = await fixture();
  try {
    f.privacy.remember("PRIVATE_MARKER_913");
    f.put("item", {
      id: "private",
      threadId: "thread",
      seq: 4,
      kind: "message",
      body: { text: "PRIVATE_MARKER_913" },
      createdAt: at,
    });
    await expect(
      f.api("thread.fork", { id: "thread", kind: "copied" }, "private-copy"),
    ).rejects.toThrow();
    expect(f.store.receipt("private-copy")).toBeUndefined();
    f.put("item", { ...f.store.record("item", "private"), body: { text: "RECENT_PUBLIC" } });
    f.put("item", { ...f.store.record("item", "source-message"), seq: 2 });
    f.put("item", {
      id: "huge",
      threadId: "thread",
      seq: 1,
      kind: "message",
      body: { text: "x".repeat(40_000) },
      createdAt: at,
    });
    expect(await f.api("thread.forkPreview", { id: "thread", kind: "copied" })).toMatchObject({
      copiedMessages: 2,
      omittedMessages: 1,
    });
    const profile = parse(ProfileSchema, f.store.record("agent", "destination"));
    f.put("agent", { ...profile, archived: true });
    await expect(
      f.api("thread.fork", { id: "thread", destinationProfileId: "destination" }, "archived"),
    ).rejects.toThrow("fork_destination_unavailable");
  } finally {
    await f.clean();
  }
});

it("redacts values learned after the copied snapshot before first delivery", async () => {
  const f = await fixture();
  try {
    f.put("item", {
      ...f.store.record("item", "source-message"),
      body: { text: "LATE_PRIVATE_VALUE_617" },
    });
    const child = (await f.api(
      "thread.fork",
      { id: "thread", kind: "copied" },
      "late-secret",
    )) as ForkOperation;
    f.privacy.remember("LATE_PRIVATE_VALUE_617");
    await f.send(child.childThreadId, "CONTINUE_SAFELY");
    expect(JSON.stringify(f.natives[0]?.received)).not.toContain("LATE_PRIVATE_VALUE_617");
    expect(JSON.stringify(f.natives[0]?.received)).toContain("CONTINUE_SAFELY");
  } finally {
    await f.clean();
  }
});

it("copies visible history when a provider has no resumable native identity or native turn mapping", async () => {
  const f = await fixture();
  try {
    f.put("session", {
      ...f.store.record("session", "session"),
      id: "nonresumable-head",
      startedAt: "2026-11-07T00:00:00Z",
      nativeId: undefined,
      capabilities: {},
    });
    expect(await f.api("thread.forkPreview", { id: "thread" })).toMatchObject({
      available: true,
      kind: "copied",
    });
    const copy = (await f.api("thread.fork", { id: "thread" }, "no-native-id")) as ForkOperation;
    expect(copy.kind).toBe("copied");
    expect(f.store.record("thread", copy.childThreadId)?.fork).toMatchObject({
      sourceSessionId: "nonresumable-head",
    });
    expect(f.store.record("thread", copy.childThreadId)?.fork).not.toHaveProperty("sourceNativeId");
    expect(f.requests).toHaveLength(0);
  } finally {
    await f.clean();
  }
});

it("copies history up to a chosen message so it can be edited and sent again", async () => {
  const f = await fixture();
  try {
    for (const [seq, text] of [
      [40, "FIRST_MESSAGE"],
      [42, "SECOND_MESSAGE"],
    ] as const) {
      f.put("turn", {
        id: `turn-${text}`,
        threadId: "thread",
        sessionId: "session",
        status: "completed",
        origin: "human",
        startedAt: at,
        endedAt: at,
      });
      f.put("item", {
        id: text,
        threadId: "thread",
        turnId: `turn-${text}`,
        kind: "user",
        seq,
        body: {
          input: [{ type: "text", text }],
          mode: "queue",
          origin: "human",
          queueState: "sent",
        },
        createdAt: at,
        updatedAt: at,
      });
    }
    const turnId = "turn-SECOND_MESSAGE";
    const boundary = { kind: "before_user", turnId };
    expect(
      await f.api("thread.forkPreview", { id: "thread", kind: "copied", boundary }),
    ).toMatchObject({ available: true, kind: "copied" });
    const child = (await f.api(
      "thread.fork",
      { id: "thread", kind: "copied", boundary },
      "edit-from-here",
    )) as ForkOperation;
    expect(child.boundary).toEqual(boundary);
    const context = JSON.stringify(
      f.store.record("settings", copiedContextKey(child.childThreadId)),
    );
    expect(context).toContain("FIRST_MESSAGE");
    expect(context).not.toContain("SECOND_MESSAGE");
    await expect(
      f.api(
        "thread.fork",
        { id: "thread", kind: "copied", boundary: { kind: "before_user", turnId: "missing" } },
        "missing-turn",
      ),
    ).rejects.toThrow("fork_boundary_unavailable");
  } finally {
    await f.clean();
  }
});
