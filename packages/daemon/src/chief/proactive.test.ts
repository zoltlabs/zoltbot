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
