import { afterEach, describe, expect, it } from "vitest";
import { runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import { chiefClearApi, chiefHandoff, handoffPrefix, handoffTimeoutMs } from "./clear.js";
import { chiefThreadId } from "./identity.js";
import { ensureChief, previousChiefChats } from "./keeper.js";
import { chiefFixture } from "./test-fixture.js";

const start = Date.parse("2026-10-28T13:00:00Z");
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function clearer(store: Awaited<ReturnType<typeof runtimeFixture>>["store"]) {
  let clock = start;
  const wakes: string[] = [];
  const stopped: string[] = [];
  const errors: string[] = [];
  const clear = chiefClearApi({
    store,
    publish() {},
    stopThread: async (id) => {
      stopped.push(id);
    },
    clearInteractions: async () => undefined,
    wake: async (id) => {
      wakes.push(id);
    },
    now: () => clock,
    pollMs: 60_000,
    onError: (code) => errors.push(code),
  });
  closers.push(clear.close);
  return {
    clear,
    wakes,
    stopped,
    advance(ms: number) {
      clock += ms;
    },
  };
}
const userItems = (store: Awaited<ReturnType<typeof runtimeFixture>>["store"], id: string) =>
  (store.snapshot(["item"]).item ?? []).filter((row) => row.threadId === id && row.kind === "user");

describe("chief.clear", () => {
  it("starts a fresh chat at once when Zolt never answered", async () => {
    const { store } = await runtimeFixture();
    const first = ensureChief({ store, publish() {} }) as string;
    const { clear, wakes } = clearer(store);
    const result = (await clear.api("chief.clear", {}, "clear-1")) as Record<string, unknown>;
    expect(result).toMatchObject({ previousThreadId: first, handedOff: false });
    expect(chiefThreadId(store.snapshot(["settings", "thread"]))).toBe(result.threadId);
    expect(previousChiefChats(store.snapshot(["settings"]))).toEqual([first]);
    expect(wakes).toEqual([]);
  });

  it("asks Zolt for a handoff, then hands it to the new chat", async () => {
    const { f, put, change } = await chiefFixture();
    const { clear, wakes } = clearer(f.store);
    await expect(clear.api("chief.clear", {}, "busy")).rejects.toThrow("Zolt is working");
    put("turn", "turn", { status: "completed", endedAt: "2026-10-28T12:30:00Z" });

    const pending = await clear.api("chief.clear", {}, "clear-1");
    expect(pending).toEqual({ threadId: "thread", handingOff: true });
    expect(wakes).toEqual(["thread"]);
    const prompt = userItems(f.store, "thread").find((row) =>
      String(row.id).startsWith(handoffPrefix),
    );
    expect(JSON.stringify(prompt?.body)).toContain("chief_handoff");
    // Still the same chat while Zolt has not answered, and a second Clear changes nothing.
    expect(await clear.finish()).toBeUndefined();
    expect(await clear.api("chief.clear", {}, "clear-2")).toEqual(pending);

    const handoff = { text: "Waiting on the Coach V2 pricing answer.", fromThreadId: "thread" };
    change({
      type: "create",
      kind: "settings",
      value: {
        key: "chief.handoff",
        value: { ...handoff, at: new Date(start + 5000).toISOString() },
      },
    });
    expect(chiefHandoff(f.store.snapshot(["settings"]))?.text).toBe(handoff.text);
    await clear.finish();

    const after = f.store.snapshot(["settings", "thread"]);
    const fresh = chiefThreadId(after) as string;
    expect(fresh).not.toBe("thread");
    expect(after.thread?.find((row) => row.id === "thread")?.archived).toBe(true);
    expect(after.settings?.find((row) => row.key === "chief.clearing")?.value).toEqual({});
    expect(JSON.stringify(userItems(f.store, fresh)[0]?.body)).toContain(handoff.text);
    expect(wakes).toEqual(["thread", fresh]);
  });

  it("switches without a handoff when Zolt doesn't write one in time", async () => {
    const { f, put } = await chiefFixture();
    put("turn", "turn", { status: "completed", endedAt: "2026-10-28T12:30:00Z" });
    const { clear, advance, wakes } = clearer(f.store);
    await clear.api("chief.clear", {}, "clear-1");
    advance(handoffTimeoutMs);
    await clear.finish();
    const fresh = chiefThreadId(f.store.snapshot(["settings", "thread"])) as string;
    expect(fresh).not.toBe("thread");
    expect(userItems(f.store, fresh)).toEqual([]);
    expect(wakes).toEqual(["thread"]);
  });

  it("lets Zolt save a handoff with chief_handoff", async () => {
    const { f, call } = await chiefFixture();
    expect(await call("chief_handoff", { text: "  Promised a Friday release check. " })).toEqual({
      ok: true,
    });
    expect(chiefHandoff(f.store.snapshot(["settings"]))).toMatchObject({
      text: "Promised a Friday release check.",
      fromThreadId: "thread",
    });
  });
});
