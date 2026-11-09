import { compareSummaryPrompt, handle, requestSessionMode } from "@zoltbot/core";
import {
  type CompareCreate,
  type DomainEvent,
  macOnlyMethods,
  ProfileSchema,
  parse,
} from "@zoltbot/protocol";
import { expect, it, vi } from "vitest";
import { CompareFakeSession } from "../../../tools/fakes/src/compare-runtime.js";
import { at, runtimeFixture } from "../../../tools/fakes/src/runtime-fixture.js";
import { compareApi } from "./compare-api.js";
import { PrivateInputGuard } from "./private-input.js";
import { SessionManager } from "./session-manager.js";

const context = (commandId: string) => ({
  commandId,
  at,
  actor: { kind: "human" as const, id: "owner" },
});
const create: CompareCreate = {
  value: { id: "comparison", title: "Think together", ceiling: "read_only" },
  members: [
    { threadId: "one", profileId: "profile" },
    { threadId: "two", profileId: "other" },
  ],
  input: [{ type: "text", text: "Give me three ideas" }],
};
async function fixture(failSecond = false) {
  const f = await runtimeFixture();
  const def = f.store.record("agentDefinition", "fake");
  if (!def) throw Error("fixture_definition_missing");
  f.store.dispatch("capability", (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "agentDefinition",
        id: "fake",
        changes: { staticCapabilities: { readOnly: true } },
      },
      context("capability"),
    ),
  );
  f.store.dispatch("permission", (state) =>
    handle(
      state,
      {
        type: "update",
        kind: "agent",
        id: "profile",
        changes: { permissionProfile: "workspace_write" },
        confirmed: true,
      },
      context("permission"),
    ),
  );
  const profile = parse(ProfileSchema, f.store.record("agent", "profile"));
  f.store.dispatch("other", (state) =>
    handle(
      state,
      { type: "create", kind: "agent", value: { ...profile, id: "other", name: "Other" } },
      context("other"),
    ),
  );
  const published: DomainEvent[] = [],
    natives = new Map<string, CompareFakeSession>(),
    permissions: string[] = [];
  const manager = new SessionManager({
    store: f.store,
    publish: (events) => published.push(...events),
    host: {
      async prepare(input) {
        permissions.push(input.profile.permissionProfile);
        return {
          cwd: f.root,
          estimate: (text) => text.length,
          fixedInjectedTokens: 0,
          async open() {
            const native = new CompareFakeSession(
              input.thread.id,
              input.thread.id === "one" ? 15 : 80,
              failSecond && input.thread.id === "two",
            );
            natives.set(input.thread.id, native);
            return native;
          },
        };
      },
    },
  });
  const privacy = new PrivateInputGuard({
    store: f.store,
    publish: (events) => published.push(...events),
  });
  const api = compareApi({
    store: f.store,
    privacy,
    publish: (events) => published.push(...events),
    wake: async (id) => (await manager.ensure(id)).wake(),
  });
  return {
    ...f,
    api,
    manager,
    natives,
    permissions,
    privacy,
    async clean() {
      await manager.close();
      f.close();
    },
  };
}
it("atomically creates, replays and independently streams identical human input with a read-only ceiling", async () => {
  const f = await fixture();
  try {
    const result = await f.api("compare.create", create, "create");
    expect(await f.api("compare.create", structuredClone(create), "create")).toEqual(result);
    await expect(
      f.api("compare.create", { ...create, input: [{ type: "text", text: "changed" }] }, "create"),
    ).rejects.toThrow("command_receipt_conflict");
    await expect.poll(() => f.natives.get("two")?.received.length).toBe(1);
    expect(f.permissions).toEqual(["read_only", "read_only"]);
    expect(f.natives.get("one")?.received).toEqual([create.input]);
    expect(f.natives.get("two")?.received).toEqual([create.input]);
    expect(f.store.snapshot().compareMember).toHaveLength(2);
    await expect
      .poll(
        () =>
          f.store
            .snapshot()
            .turn?.filter((row) => row.threadId === "one" && row.status === "completed").length,
      )
      .toBe(1);
    expect(
      f.store.snapshot().turn?.some((row) => row.threadId === "two" && row.status === "running"),
    ).toBe(true);
    await f.api(
      "compare.send",
      { id: "comparison", input: [{ type: "text", text: "Follow up" }] },
      "follow",
    );
    expect(
      f.store
        .snapshot()
        .item?.filter(
          (row) =>
            row.kind === "user" && (row.body as { queueState: string }).queueState === "queued",
        ).length,
    ).toBeGreaterThan(0);
    await expect.poll(() => f.natives.get("two")?.received.length).toBe(2);
    await expect
      .poll(
        () =>
          f.store
            .snapshot()
            .turn?.filter(
              (row) => ["one", "two"].includes(String(row.threadId)) && row.status === "running",
            ).length,
      )
      .toBe(0);
    await f.api("compare.vote", { id: "comparison", threadId: "one", vote: "better" }, "vote1");
    await f.api("compare.vote", { id: "comparison", threadId: "two", vote: "better" }, "vote2");
    expect(
      f.store
        .snapshot()
        .compareMember?.filter((row) => row.vote === "better")
        .map((row) => row.threadId),
    ).toEqual(["two"]);
    await f.api(
      "compare.resolve",
      { id: "comparison", action: "continue", threadId: "two" },
      "resolve",
    );
    expect(f.store.record("thread", "two")?.kind).toBe("main");
    expect(
      f.store
        .snapshot()
        .item?.some(
          (row) => row.kind === "note" && (row.body as { code: string }).code === "compare",
        ),
    ).toBe(true);
    await f.manager.ensure("two").then((worker) => worker.wake());
    expect(f.natives.get("two")?.received).toHaveLength(2);
    expect(JSON.stringify([...f.natives.values()].map((n) => n.received))).not.toContain(
      "Compared",
    );
    const session = f.store.snapshot().session?.find((row) => row.threadId === "two");
    expect(() =>
      requestSessionMode(
        f.store.snapshot(),
        String(session?.id),
        "bypassPermissions",
        context("bypass"),
        true,
      ),
    ).toThrow("compare_permission_ceiling");
    await expect(
      f.api(
        "compare.widen",
        { id: "comparison", threadId: "two", confirmed: false },
        "unconfirmed",
      ),
    ).rejects.toThrow("confirmation_required");
    await f.api("compare.widen", { id: "comparison", threadId: "two", confirmed: true }, "widen");
    expect(f.store.snapshot().audit?.some((row) => row.action === "compare.widen")).toBe(true);
    console.info(
      "Compare fake first tokens (ms)",
      JSON.stringify([...f.natives].map(([id, native]) => ({ id, ms: native.firstTokens }))),
    );
    expect(f.store.snapshot().usage?.length).toBeGreaterThan(0);
    await f.manager.stopSession(String(session?.id));
    await f.manager.ensure("two");
    expect(f.permissions.at(-1)).toBe("workspace_write");
    expect(f.store.snapshot().usage?.every((row) => row.injectedTokens === 0)).toBe(true);
    expect(macOnlyMethods).toContain("compare.create");
  } finally {
    await f.clean();
  }
});
it("rolls back a forced SQL failure midway, rejects unknown support and duplicate profiles before writes", async () => {
  const f = await fixture();
  try {
    const before = f.store.lastSeq();
    f.store.database.exec(
      "CREATE TRIGGER fail_compare BEFORE INSERT ON compare_members WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'forced_compare_failure'); END",
    );
    await expect(f.api("compare.create", create, "fail")).rejects.toThrow("forced_compare_failure");
    expect(f.store.lastSeq()).toBe(before);
    expect(f.store.record("thread", "one")).toBeUndefined();
    expect(f.store.receipt("fail")).toBeUndefined();
    expect(f.store.snapshot().compare).toBeUndefined();
    f.store.database.exec("DROP TRIGGER fail_compare");
    await expect(
      f.api(
        "compare.create",
        { ...create, members: [create.members[0], { threadId: "two", profileId: "profile" }] },
        "duplicates",
      ),
    ).rejects.toThrow("compare_distinct_members_required");
    f.store.dispatch("unsupported", (state) =>
      handle(
        state,
        {
          type: "update",
          kind: "agentDefinition",
          id: "fake",
          changes: { staticCapabilities: {} },
        },
        context("unsupported"),
      ),
    );
    const unsupportedBefore = f.store.lastSeq();
    await expect(f.api("compare.create", create, "unsupported-create")).rejects.toThrow(
      "compare_read_only_unavailable",
    );
    expect(f.store.lastSeq()).toBe(unsupportedBefore);
    expect(f.permissions).toEqual([]);
  } finally {
    await f.clean();
  }
});

it("keeps the healthy column usable when another provider fails mid-turn", async () => {
  const f = await fixture(true);
  try {
    await f.api("compare.create", create, "failure-isolated");
    await expect
      .poll(() => f.store.snapshot().turn?.find((row) => row.threadId === "two")?.status)
      .toBe("failed");
    expect(f.store.snapshot().turn?.find((row) => row.threadId === "one")?.status).toBe(
      "completed",
    );
    expect(f.natives.get("one")?.received).toEqual([create.input]);
    expect(f.natives.get("two")?.received).toEqual([create.input]);
  } finally {
    await f.clean();
  }
});

it("creates one opt-in summary atomically with exact visible input and a permanent read-only ceiling", async () => {
  const f = await fixture();
  try {
    await f.api("compare.create", create, "create");
    await expect
      .poll(() => f.store.snapshot().turn?.filter((r) => r.status === "completed").length)
      .toBe(2);
    expect(f.natives.size).toBe(2);
    expect(f.store.record("compare", "comparison")?.summaryThreadId).toBeUndefined();
    const prompt = compareSummaryPrompt(f.store.snapshot(), "comparison"),
      params = { id: "comparison", profileId: "profile", expectedPrompt: prompt };
    f.store.database.exec(
      "CREATE TRIGGER reject_summary BEFORE INSERT ON items WHEN NEW.kind='user' AND NEW.thread_id NOT IN ('one','two','thread') BEGIN SELECT RAISE(ABORT,'forced_summary_failure'); END",
    );
    const threads = f.store.snapshot().thread?.length;
    await expect(f.api("compare.differences", params, "summary")).rejects.toThrow(
      "forced_summary_failure",
    );
    expect(f.store.snapshot().thread?.length).toBe(threads);
    expect(f.store.record("compare", "comparison")?.summaryThreadId).toBeUndefined();
    expect(f.store.receipt("summary")).toBeUndefined();
    expect(f.natives.size).toBe(2);
    f.store.database.exec("DROP TRIGGER reject_summary");
    const guard = vi.spyOn(f.privacy, "prepareData");
    const result = (await f.api("compare.differences", params, "summary")) as {
      summaryThreadId: string;
      created: boolean;
    };
    expect(result.created).toBe(true);
    expect(guard).toHaveBeenCalledWith({ params, prompt });
    expect(await f.api("compare.differences", params, "summary")).toEqual(result);
    await expect(
      f.api("compare.differences", { ...params, profileId: "other" }, "summary"),
    ).rejects.toThrow("command_receipt_conflict");
    expect(await f.api("compare.differences", params, "summary-again")).toMatchObject({
      summaryThreadId: result.summaryThreadId,
      created: false,
    });
    await expect
      .poll(
        () => f.store.snapshot().turn?.find((r) => r.threadId === result.summaryThreadId)?.status,
      )
      .toBe("completed");
    expect(f.natives.size).toBe(3);
    expect(f.store.snapshot().compareMember).toHaveLength(2);
    expect(f.store.record("thread", result.summaryThreadId)?.kind).toBe("side");
    const item = f.store
      .snapshot()
      .item?.find((r) => r.threadId === result.summaryThreadId && r.kind === "user");
    expect((item?.body as { input: unknown }).input).toEqual([{ type: "text", text: prompt }]);
    expect(f.natives.get(result.summaryThreadId)?.received).toEqual([
      [{ type: "text", text: prompt }],
    ]);
    expect(f.natives.get("one")?.received).toEqual([create.input]);
    expect(f.natives.get("two")?.received).toEqual([create.input]);
    expect(f.permissions).toEqual(["read_only", "read_only", "read_only"]);
    const session = f.store.snapshot().session?.find((r) => r.threadId === result.summaryThreadId);
    expect(() =>
      requestSessionMode(
        f.store.snapshot(),
        String(session?.id),
        "acceptEdits",
        context("summary-mode"),
        true,
      ),
    ).toThrow("compare_summary_permission_ceiling");
    const usage = f.store.snapshot().usage?.filter((r) => r.sessionId === session?.id);
    expect(usage?.length).toBeGreaterThan(0);
    expect(usage?.every((r) => r.injectedTokens === 0)).toBe(true);
    await f.api("compare.resolve", { id: "comparison", action: "close" }, "close");
    await expect(f.api("compare.differences", params, "after-close")).rejects.toThrow(
      "compare_not_open",
    );
  } finally {
    await f.clean();
  }
});

it("refuses a stale summary preview without writes even if answers change during privacy preparation", async () => {
  const f = await fixture();
  try {
    await f.api("compare.create", create, "create");
    await expect
      .poll(() => f.store.snapshot().turn?.filter((r) => r.status === "completed").length)
      .toBe(2);
    const prompt = compareSummaryPrompt(f.store.snapshot(), "comparison"),
      params = { id: "comparison", profileId: "profile", expectedPrompt: prompt };
    await expect(
      f.api("compare.differences", { ...params, expectedPrompt: "outdated" }, "outdated"),
    ).rejects.toThrow("compare_answers_changed");
    const item = f.store.snapshot().item?.find((r) => r.threadId === "one" && r.kind === "message");
    if (!item) throw Error("missing answer");
    const original = f.privacy.prepareData.bind(f.privacy);
    vi.spyOn(f.privacy, "prepareData").mockImplementationOnce(async (data) => {
      const check = await original(data);
      f.store.dispatch("changed-answer", (state) =>
        handle(
          state,
          {
            type: "update",
            kind: "item",
            id: String(item.id),
            changes: {
              body: { ...(item.body as Record<string, unknown>), text: "A newer final answer" },
            },
          },
          context("changed-answer"),
        ),
      );
      return check;
    });
    await expect(f.api("compare.differences", params, "raced")).rejects.toThrow(
      "compare_answers_changed",
    );
    expect(f.store.receipt("raced")).toBeUndefined();
    expect(f.store.record("compare", "comparison")?.summaryThreadId).toBeUndefined();
    expect(f.natives.size).toBe(2);
  } finally {
    await f.clean();
  }
});
