import { expect, it } from "vitest";
import { chiefWaker, localDay } from "./proactive.js";
import { at, chiefFixture } from "./test-fixture.js";

const minute = 60_000;
async function setup() {
  const fixture = await chiefFixture();
  const { change, f, put } = fixture;
  // The chief is idle: its last turn ended when the fixture started.
  put("turn", "turn", { status: "completed", endedAt: at });
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
  };
  const local = (time: number) =>
    `${String(new Date(time).getHours()).padStart(2, "0")}:${String(new Date(time).getMinutes()).padStart(2, "0")}`;
  /** Brief at half an hour after the fixture's start, in local time. */
  const turnOn = () =>
    change({
      type: "create",
      kind: "settings",
      value: {
        key: "chief.proactive",
        value: { brief: { enabled: true, time: local(Date.parse(at) + 30 * minute) } },
      },
    });
  let turns = 0;
  /** A workspace chat finishes a turn now. */
  const finish = (threadId = "worker", status = "completed") => {
    const id = `worker-turn-${++turns}`,
      now = new Date(clock).toISOString();
    change({
      type: "create",
      kind: "turn",
      value: {
        id,
        sessionId: "worker-session",
        threadId,
        status: "running",
        origin: "human",
        startedAt: now,
      },
    });
    put("turn", id, { status, endedAt: now });
  };
  const notices = () =>
    (f.store.snapshot(["item"]).item ?? [])
      .filter((row) => String(row.id).startsWith("chief-wake:"))
      .map((row) => ({
        id: String(row.id),
        text: String((row.body as { input: { text: string }[] }).input[0]?.text),
      }));
  return { ...fixture, waker, advance, wakes, turnOn, finish, notices, now: () => clock };
}

it("sends one brief a day at your time, only when something happened", async () => {
  const { f, waker, advance, wakes, turnOn, finish, notices, settingValue, now } = await setup();
  try {
    finish();
    advance(40);
    // Off until you turn it on.
    expect(await waker.tick()).toEqual({ wake: false, reason: "nothing" });
    turnOn();
    advance(-20);
    expect(await waker.tick()).toEqual({ wake: false, reason: "nothing" });
    expect(notices()).toEqual([]);
    advance(20);
    expect(await waker.tick()).toMatchObject({ wake: true, brief: true });
    expect(wakes).toEqual(["thread"]);
    const [brief] = notices();
    expect(brief?.id).toBe(`chief-wake:brief:${localDay(now())}`);
    expect(brief?.text).toMatch(/^\[Zoltbot\] Zolt, this is the user's morning brief/);
    expect(brief?.text).toContain('Finished: "Fix onboarding" (worker).');
    expect(brief?.text).toContain("Never call chief_answer here.");
    // It counts against the day's wake-ups.
    expect(settingValue("chief.wake")).toMatchObject({ used: 1 });
    expect(settingValue("chief.brief")).toEqual({ day: localDay(now()), at: expect.any(String) });
    advance(60);
    expect(await waker.tick()).not.toMatchObject({ brief: true });
    expect(notices()).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("skips a day with nothing new, and a brief that would be hours late", async () => {
  const { f, waker, advance, turnOn, finish, notices, settingValue, now, put } = await setup();
  try {
    turnOn();
    advance(31);
    expect(await waker.tick()).toEqual({ wake: false, reason: "nothing" });
    expect(settingValue("chief.brief")).toMatchObject({ day: localDay(now()) });
    expect(notices()).toEqual([]);
    // Next day, something finished, but the computer slept until the afternoon.
    advance(24 * 60 - 31);
    finish("worker", "failed");
    advance(31 + 5 * 60);
    await waker.tick();
    expect(notices()).toEqual([]);
    expect(settingValue("chief.brief")).toMatchObject({ day: localDay(now()) });
    // The next morning still reports the failure it missed.
    advance(24 * 60 - 5 * 60);
    put("turn", "turn", { status: "completed", endedAt: new Date(now()).toISOString() });
    expect(await waker.tick()).toMatchObject({ wake: true, brief: true });
    expect(notices()[0]?.text).toContain('Failed: "Fix onboarding" (worker).');
  } finally {
    f.close();
  }
});

it("counts a brief as useful once Zolt writes it", async () => {
  const { f, waker, advance, turnOn, finish, change, put, settingValue, now } = await setup();
  try {
    turnOn();
    finish();
    advance(31);
    expect(await waker.tick()).toMatchObject({ brief: true });
    const started = new Date(now() + 1000).toISOString();
    change({
      type: "create",
      kind: "turn",
      value: {
        id: "brief-turn",
        sessionId: "session",
        threadId: "thread",
        status: "running",
        origin: "human",
        startedAt: started,
      },
    });
    const notice = String(
      (f.store.snapshot(["item"]).item ?? []).find((row) =>
        String(row.id).startsWith("chief-wake:"),
      )?.id,
    );
    put("item", notice, {
      body: {
        queueVersion: 1,
        input: [{ type: "text", text: "brief" }],
        mode: "queue",
        queueState: "handled",
      },
    });
    change({
      type: "create",
      kind: "item",
      value: {
        id: "brief-reply",
        threadId: "thread",
        kind: "message",
        seq: 5000,
        body: { text: "Onboarding fix finished. Nothing needs you." },
        createdAt: started,
        updatedAt: started,
      },
    });
    put("turn", "brief-turn", { status: "completed", endedAt: started });
    advance(1);
    await waker.tick();
    expect(settingValue("chief.wake")).toMatchObject({ wasted: 0, results: [{ useful: true }] });
  } finally {
    f.close();
  }
});
