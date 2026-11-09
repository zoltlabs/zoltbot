import { expect, it } from "vitest";
import { chiefWaker } from "./proactive.js";
import { at, chiefFixture } from "./test-fixture.js";

const minute = 60_000;
async function setup() {
  const fixture = await chiefFixture();
  const { change, f, put } = fixture;
  // The chief is idle: its last turn ended when the fixture started.
  fixture.put("turn", "turn", { status: "completed", endedAt: at });
  for (const id of ["api", "docs"])
    change({
      type: "create",
      kind: "thread",
      value: {
        id,
        agentId: "profile",
        projectId: "coach",
        node: { type: "project", id: "coach" },
        kind: "side",
        title: id === "api" ? "API work" : "Docs",
        titleSource: "human",
        pinned: false,
        archived: false,
        createdAt: at,
        lastActivityAt: at,
      },
    });
  let clock = Date.parse(at);
  const wakes: string[] = [];
  const waker = chiefWaker({
    store: f.store,
    publish() {},
    wake: async (threadId) => {
      wakes.push(threadId);
    },
    now: () => clock,
    intervalMs: 3_600_000,
  });
  const advance = (minutes: number) => {
    clock += minutes * minute;
    return new Date(clock).toISOString();
  };
  const notices = () =>
    (f.store.snapshot(["item"]).item ?? [])
      .filter((row) => row.threadId === "thread" && String(row.id).startsWith("chief-wake:"))
      .map((row) => ({
        id: String(row.id),
        text: String((row.body as { input: { text: string }[] }).input[0]?.text),
      }));
  let turns = 0;
  /** The chief runs the turn a wake-up started, doing `work` while it runs. */
  const runTurn = (work: () => void = () => {}) => {
    const notice = notices().at(-1);
    const id = `chief-turn-${++turns}`,
      started = new Date(clock + 1000).toISOString();
    change({
      type: "create",
      kind: "turn",
      value: {
        id,
        sessionId: "session",
        threadId: "thread",
        status: "running",
        origin: "human",
        startedAt: started,
      },
    });
    if (notice)
      put("item", notice.id, {
        body: {
          queueVersion: 1,
          input: [{ type: "text", text: notice.text }],
          mode: "queue",
          queueState: "handled",
        },
      });
    work();
    put("turn", id, { status: "completed", endedAt: new Date(clock + 2000).toISOString() });
  };
  /** Requests raised now, on the test clock. */
  const request = (threadId: string, draft: Parameters<typeof fixture.request>[1]) =>
    fixture.request(threadId, { ...draft, createdAt: new Date(clock + 1000).toISOString() });
  return { ...fixture, request, waker, advance, wakes, notices, runTurn };
}

it("turns a burst of approvals into exactly one wake-up after they settle", async () => {
  const { f, waker, advance, request, wakes, notices, settingValue } = await setup();
  try {
    const ids = [];
    for (let index = 0; index < 10; index++)
      ids.push(
        request(["worker", "api", "docs"][index % 3] as string, {
          type: "approval",
          title: `Run step ${index}`,
        }),
      );
    advance(11);
    // You were here when the daemon started; wait until you step away.
    expect(await waker.tick()).toMatchObject({ wake: true });
    expect(wakes).toEqual(["thread"]);
    const [notice] = notices();
    for (const id of ids) expect(notice?.text).toContain(`(${id}) is not triaged.`);
    expect(notice?.text).toMatch(
      /^\[Zoltbot\] Zolt, this is a wake-up, not a message from the user\./,
    );
    expect(notice?.text).toContain("Never call chief_answer here.");
    expect(settingValue("chief.wake")).toMatchObject({ used: 1, pending: { itemId: notice?.id } });
    // The same signals never wake it twice.
    advance(60);
    expect(await waker.tick()).toEqual({ wake: false, reason: "gap" });
    expect(wakes).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("sends nothing when everything was dealt with before the wake-up", async () => {
  const { f, waker, advance, request, wakes, put } = await setup();
  try {
    const id = request("worker", { type: "approval", title: "Run tests" });
    advance(5);
    expect(await waker.tick()).toEqual({ wake: false, reason: "coalescing" });
    put("interaction", id, { state: "answered" });
    advance(10);
    expect(await waker.tick()).toEqual({ wake: false, reason: "nothing" });
    expect(wakes).toEqual([]);
  } finally {
    f.close();
  }
});

it("wakes for a failed chat it tracks, never for chats finishing or other failures", async () => {
  const { f, waker, advance, wakes, change, call, put } = await setup();
  try {
    const turn = (id: string, threadId: string, status: string) => {
      const ended = advance(1);
      change({
        type: "create",
        kind: "turn",
        value: {
          id,
          sessionId: "worker-session",
          threadId,
          status: "running",
          origin: "human",
          startedAt: ended,
        },
      });
      put("turn", id, { status, endedAt: ended });
    };
    turn("api-done", "api", "completed");
    turn("docs-failed", "docs", "failed");
    advance(30);
    expect(await waker.tick()).toEqual({ wake: false, reason: "nothing" });
    // A note means Zolt is tracking the chat, so its failure is worth a turn.
    await call("chief_note", { chatId: "docs", text: "Watching the docs build" });
    turn("docs-failed-again", "docs", "failed");
    advance(11);
    expect(await waker.tick()).toMatchObject({
      wake: true,
      signals: [{ kind: "failed", text: 'Chat "Docs" (docs) failed.' }],
    });
    expect(wakes).toEqual(["thread"]);
  } finally {
    f.close();
  }
});

it("waits while the user is around, during quiet hours, between wake-ups and past the allowance", async () => {
  const { f, waker, advance, request, change, runTurn, call, settingValue } = await setup();
  try {
    request("worker", { type: "approval", title: "First" });
    advance(11);
    waker.active();
    expect(await waker.tick()).toEqual({ wake: false, reason: "user_active" });
    advance(11);
    const hour = new Date(Date.parse(at) + 22 * minute).getHours();
    change({
      type: "create",
      kind: "settings",
      value: {
        key: "notifications",
        value: {
          quietHours: {
            enabled: true,
            start: `${String(hour).padStart(2, "0")}:00`,
            end: `${String((hour + 1) % 24).padStart(2, "0")}:00`,
          },
        },
      },
    });
    expect(await waker.tick()).toEqual({ wake: false, reason: "quiet_hours" });
    change({
      type: "update",
      kind: "settings",
      id: "notifications",
      changes: { value: {} },
    });
    expect(await waker.tick()).toMatchObject({ wake: true });
    runTurn();
    // A useful turn: it triaged what it was woken for.
    await call("chief_triage", {
      items: [
        {
          interactionId: String(
            f.store.snapshot(["interaction"]).interaction?.find((row) => row.title === "First")?.id,
          ),
          rank: "today",
          why: "Fine to wait",
        },
      ],
    });
    advance(1);
    request("worker", { type: "approval", title: "Second" });
    advance(30);
    expect(await waker.tick()).toEqual({ wake: false, reason: "gap" });
    expect(settingValue("chief.wake")).toMatchObject({
      wasted: 0,
      results: [{ useful: true }],
    });
    change({
      type: "update",
      kind: "settings",
      id: "chief.wake",
      changes: { value: { ...(settingValue("chief.wake") as object), used: 5 } },
    });
    advance(90);
    expect(await waker.tick()).toEqual({ wake: false, reason: "allowance" });
  } finally {
    f.close();
  }
});

it("halves the allowance after three wasted wake-ups and stays off when turned off", async () => {
  const { f, waker, advance, request, runTurn, settingValue, change } = await setup();
  try {
    for (let round = 0; round < 3; round++) {
      request("worker", { type: "approval", title: `Round ${round}` });
      advance(round ? 91 : 11);
      expect(await waker.tick()).toMatchObject({ wake: true });
      runTurn();
      advance(1);
      await waker.tick();
    }
    expect(settingValue("chief.wake")).toMatchObject({
      used: 3,
      wasted: 3,
      results: [{ useful: false }, { useful: false }, { useful: false }],
    });
    request("worker", { type: "approval", title: "Round 4" });
    advance(91);
    // Five a day, halved to two, and three are used.
    expect(await waker.tick()).toEqual({ wake: false, reason: "allowance" });
    change({
      type: "create",
      kind: "settings",
      value: { key: "chief.proactive", value: { enabled: false } },
    });
    expect(await waker.tick()).toEqual({ wake: false, reason: "off" });
  } finally {
    f.close();
  }
});

/** A wake-up turn whose work may call tools. */
async function wakeTurn(
  fixture: Awaited<ReturnType<typeof setup>>,
  id: string,
  work: () => Promise<unknown> = async () => {},
) {
  const { change, put, notices } = fixture;
  const notice = notices().at(-1);
  const started = fixture.advance(0);
  change({
    type: "create",
    kind: "turn",
    value: {
      id,
      sessionId: "session",
      threadId: "thread",
      status: "running",
      origin: "system",
      startedAt: started,
    },
  });
  if (notice)
    put("item", notice.id, {
      body: {
        queueVersion: 1,
        input: [{ type: "text", text: notice.text }],
        mode: "queue",
        queueState: "handled",
      },
    });
  await work();
  put("turn", id, { status: "completed", endedAt: fixture.advance(1) });
}

it("wakes when a chat it is waiting on finishes, past the gap, and only once", async () => {
  const fixture = await setup();
  const { f, waker, advance, call, change, put, wakes, notices, settingValue } = fixture;
  try {
    expect(await call("chief_wake_later", { op: "set", key: "api", afterChatId: "api" })).toEqual({
      error: "reason_required",
    });
    expect(
      await call("chief_wake_later", {
        op: "set",
        key: "api",
        reason: "Check the API tests",
        afterChatId: "api",
        at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    ).toEqual({ error: "set_at_or_afterChatId" });
    expect(
      await call("chief_wake_later", {
        op: "set",
        key: "soon",
        reason: "Too soon",
        at: new Date(Date.now() + minute).toISOString(),
      }),
    ).toMatchObject({ error: "time_out_of_range" });
    expect(
      await call("chief_wake_later", {
        op: "set",
        key: "api",
        reason: "Check the API tests",
        afterChatId: "api",
      }),
    ).toMatchObject({ ok: true });
    expect(await call("chief_wake_later", { op: "cancel", key: "none" })).toEqual({
      error: "not_found",
    });
    // The tool stamps the real time; move the test clock past it.
    advance(Math.ceil((Date.now() - Date.parse(advance(0))) / minute) + 30);
    // Nothing happened in the chat yet: the wake-up waits.
    expect(await waker.tick()).toEqual({ wake: false, reason: "nothing" });
    const ended = advance(1);
    change({
      type: "create",
      kind: "turn",
      value: {
        id: "api-turn",
        sessionId: "worker-session",
        threadId: "api",
        status: "running",
        origin: "human",
        startedAt: ended,
      },
    });
    put("turn", "api-turn", { status: "completed", endedAt: ended });
    // Zolt picked the moment, so it does not wait for the burst window.
    expect(await waker.tick()).toMatchObject({
      wake: true,
      signals: [{ kind: "scheduled", text: expect.stringContaining("Check the API tests") }],
    });
    expect(notices().at(-1)?.text).toContain("Wake-ups you set:");
    expect(settingValue("chief.timers")).toEqual({ items: [] });
    await wakeTurn(fixture, "chief-turn-a");
    advance(5);
    await waker.tick();
    expect(wakes).toEqual(["thread"]);
  } finally {
    f.close();
  }
});

it("skips the gap for a timed wake-up but keeps the allowance", async () => {
  const fixture = await setup();
  const { f, waker, advance, change, request, settingValue } = fixture;
  try {
    request("worker", { type: "approval", title: "First" });
    advance(11);
    expect(await waker.tick()).toMatchObject({ wake: true });
    await wakeTurn(fixture, "chief-turn-a");
    const due = advance(20);
    change({
      type: "create",
      kind: "settings",
      value: {
        key: "chief.timers",
        value: {
          items: [{ id: "timer-1", key: "landing", reason: "Flight lands", setAt: due, at: due }],
        },
      },
    });
    expect(await waker.tick()).toMatchObject({ wake: true, signals: [{ kind: "scheduled" }] });
    expect(settingValue("chief.timers")).toEqual({ items: [] });
    expect(settingValue("chief.wake")).toMatchObject({ used: 2 });
  } finally {
    f.close();
  }
});

it("reaches the user only through chief_notify, and a silent wake-up leaves the chat read", async () => {
  const fixture = await setup();
  const { f, waker, advance, request, put, call, settingValue } = fixture;
  const thread = () => f.store.record("thread", "thread");
  try {
    put("thread", "thread", { lastReadAt: advance(0) });
    request("worker", { type: "approval", title: "First" });
    advance(11);
    expect(await waker.tick()).toMatchObject({ wake: true });
    await wakeTurn(fixture, "chief-turn-a");
    advance(1);
    await waker.tick();
    // It wrote nothing for the user, so the chat stays read and the wake-up was wasted.
    expect(thread()?.lastReadAt).toBe(f.store.record("turn", "chief-turn-a")?.endedAt);
    expect(settingValue("chief.wake")).toMatchObject({ wasted: 1 });

    request("api", { type: "approval", title: "Second" });
    advance(120);
    expect(await waker.tick()).toMatchObject({ wake: true });
    await wakeTurn(fixture, "chief-turn-b", async () => {
      expect(
        await call("chief_notify", {
          key: "deploy",
          text: "The deploy needs your OK.",
          chatId: "api",
        }),
      ).toMatchObject({ ok: true });
      // The same key never sends twice.
      await call("chief_notify", { key: "deploy", text: "The deploy needs your OK." });
    });
    advance(1);
    await waker.tick();
    const notes = (f.store.runtimeSnapshot("thread").item ?? []).filter(
      (row) => (row.body as { code?: string }).code === "chief_notify",
    );
    expect(notes).toEqual([
      expect.objectContaining({
        kind: "note",
        turnId: "chief-turn-b",
        body: {
          code: "chief_notify",
          text: "The deploy needs your OK.",
          chatId: "api",
          chatTitle: "API work",
        },
      }),
    ]);
    // A notice is something to read: the chat is unread and the wake-up counted.
    expect(
      String(thread()?.lastReadAt) < String(f.store.record("turn", "chief-turn-b")?.endedAt),
    ).toBe(true);
    expect(settingValue("chief.wake")).toMatchObject({ wasted: 0 });
  } finally {
    f.close();
  }
});
