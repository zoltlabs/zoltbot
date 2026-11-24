import { handle } from "@zoltbot/core";
import { describe, expect, it, vi } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { PrivateInputGuard } from "../private-input.js";
import { threadActionsApi } from "../thread-actions.js";
import { chiefThreadId } from "./identity.js";
import { chiefKeeper, ensureChief } from "./keeper.js";

const system = { kind: "system" as const, id: "test" };
function change(
  store: Awaited<ReturnType<typeof runtimeFixture>>["store"],
  commandId: string,
  command: Parameters<typeof handle>[1],
) {
  store.dispatch(commandId, (state) => handle(state, command, { commandId, at, actor: system }));
}
const state = (store: Awaited<ReturnType<typeof runtimeFixture>>["store"]) =>
  store.snapshot(["settings", "thread", "agent", "agentDefinition"]);

describe("Zolt keeper", () => {
  it("creates Zolt's chat outside every workspace once, with the existing profile", async () => {
    const { store } = await runtimeFixture();
    const id = ensureChief({ store, publish() {} });
    expect(id).toBeDefined();
    const row = state(store).thread?.find((thread) => thread.id === id);
    expect(row).toMatchObject({ agentId: "profile", kind: "main", title: "Zolt", archived: false });
    expect(row?.projectId).toBeUndefined();
    expect(chiefThreadId(state(store))).toBe(id);
    expect(ensureChief({ store, publish() {} })).toBe(id);
    expect(state(store).thread?.filter((thread) => thread.title === "Zolt")).toHaveLength(1);
  });

  it("waits for an agent profile before creating Zolt", async () => {
    const { store } = await runtimeFixture();
    change(store, "hide", {
      type: "update",
      kind: "agent",
      id: "profile",
      changes: { archived: true },
    });
    expect(ensureChief({ store, publish() {} })).toBeUndefined();
    expect(chiefThreadId(state(store))).toBeUndefined();
  });

  it("creates Zolt soon after the first agent is added", async () => {
    vi.useFakeTimers();
    try {
      const { store } = await runtimeFixture();
      change(store, "hide", {
        type: "update",
        kind: "agent",
        id: "profile",
        changes: { archived: true },
      });
      const keeper = chiefKeeper({ store, publish() {} });
      expect(chiefThreadId(state(store))).toBeUndefined();
      change(store, "show", {
        type: "update",
        kind: "agent",
        id: "profile",
        changes: { archived: false },
      });
      keeper.soon();
      await vi.advanceTimersByTimeAsync(600);
      expect(chiefThreadId(state(store))).toBeDefined();
      keeper.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores a Zolt chat that was archived before archiving was refused", async () => {
    const { store } = await runtimeFixture();
    change(store, "point", {
      type: "create",
      kind: "settings",
      value: { key: "chief.thread", value: "thread" },
    });
    change(store, "archive", {
      type: "update",
      kind: "thread",
      id: "thread",
      changes: { archived: true },
    });
    expect(ensureChief({ store, publish() {} })).toBe("thread");
    expect(state(store).thread?.find((row) => row.id === "thread")?.archived).toBe(false);
  });

  it("refuses to archive or delete Zolt's chat", async () => {
    const { store } = await runtimeFixture();
    const id = ensureChief({ store, publish() {} }) as string;
    const actions = threadActionsApi({
      store,
      privacy: new PrivateInputGuard({ store, publish() {} }),
      publish() {},
      stopThread: async () => {},
      clearInteractions: async () => undefined,
    });
    await expect(actions("thread.archive", { id, confirmed: true }, "a")).rejects.toThrow(
      "can't be archived or deleted",
    );
    await expect(actions("thread.delete", { id, confirmed: true }, "d")).rejects.toThrow(
      "can't be archived or deleted",
    );
    expect(chiefThreadId(state(store))).toBe(id);
  });
});
