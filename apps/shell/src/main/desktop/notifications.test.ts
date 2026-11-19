import { afterEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  notices: [] as {
    options: Record<string, unknown>;
    handlers: Map<string, (...args: unknown[]) => void>;
    closed: number;
  }[],
}));
vi.mock("electron", () => ({
  Notification: class {
    static isSupported() {
      return true;
    }
    private value: {
      options: Record<string, unknown>;
      handlers: Map<string, (...args: unknown[]) => void>;
      closed: number;
    };
    constructor(options: Record<string, unknown>) {
      this.value = { options, handlers: new Map(), closed: 0 };
      fake.notices.push(this.value);
    }
    on(name: string, callback: (...args: unknown[]) => void) {
      this.value.handlers.set(name, callback);
      return this;
    }
    show() {}
    close() {
      this.value.closed++;
      this.value.handlers.get("close")?.();
    }
  },
  powerMonitor: { getSystemIdleTime: () => 120 },
}));

import { desktopNotifications } from "./notifications.js";

const at = "2026-10-28T12:00:00Z";
const approval = {
  id: "approval",
  agentId: "profile",
  threadId: "thread",
  type: "approval",
  state: "pending",
  version: 1,
  items: [
    {
      id: "approve",
      prompt: "Synthetic private detail",
      choices: [{ id: "allow_once" }, { id: "reject_once" }],
    },
  ],
  chain: [],
  urgency: "blocking",
  createdAt: at,
};
afterEach(() => {
  vi.useRealTimers();
  fake.notices.length = 0;
});
it("delivers once actions through the host and withdraws on another client's resolution", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  const answer = vi.fn(async () => {}),
    open = vi.fn(),
    failed = vi.fn();
  const notifications = desktopNotifications({
    focusedThread: () => undefined,
    answer,
    open,
    failed,
  });
  try {
    notifications.snapshot({ interaction: [approval] });
    const notice = fake.notices[0];
    if (!notice) throw new Error("fixture_notice_missing");
    expect(notice.options.actions).toEqual([
      { type: "button", text: "Open" },
      { type: "button", text: "Allow once" },
      { type: "button", text: "Reject" },
    ]);
    expect(notice.options.body).not.toContain("Synthetic private detail");
    notice.handlers.get("action")?.({}, 1);
    notice.handlers.get("action")?.({}, 1);
    await Promise.resolve();
    expect(answer).toHaveBeenCalledExactlyOnceWith("approval", 1, "allow_once");
    notifications.event("interaction", { ...approval, state: "answered", version: 2 });
    expect(notice.closed).toBe(1);
    expect(failed).not.toHaveBeenCalled();
  } finally {
    notifications.close();
  }
});
it("applies quiet settings, keeps private approvals open only, and opens the Inbox on failed actions", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  const open = vi.fn(),
    failed = vi.fn(),
    answer = vi.fn(async () => {
      throw new Error("synthetic_conflict");
    });
  const notifications = desktopNotifications({
    focusedThread: () => undefined,
    open,
    failed,
    answer,
  });
  try {
    notifications.snapshot({
      interaction: [approval],
      settings: [
        {
          key: "notifications",
          value: { quietHours: { enabled: true, start: "11:00", end: "13:00", timeZone: "UTC" } },
        },
      ],
    });
    expect(fake.notices).toHaveLength(0);
    vi.setSystemTime(new Date("2026-10-28T14:00:00Z"));
    notifications.tick();
    const publicNotice = fake.notices[0];
    if (!publicNotice) throw new Error("fixture_notice_missing");
    publicNotice.handlers.get("action")?.({}, 2);
    await Promise.resolve();
    await Promise.resolve();
    expect(answer).toHaveBeenCalledExactlyOnceWith("approval", 1, "reject_once");
    expect(open).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    notifications.snapshot({
      interaction: [
        { ...approval, id: "private", items: [{ ...approval.items[0], secret: true }] },
      ],
    });
    const privateNotice = fake.notices.at(-1);
    expect(privateNotice?.options.actions).toEqual([{ type: "button", text: "Open" }]);
  } finally {
    notifications.close();
  }
});
it("keeps requests the main agent ranked for later quiet, and withdraws one already shown", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  const notifications = desktopNotifications({
    focusedThread: () => undefined,
    open: vi.fn(),
    failed: vi.fn(),
  });
  const queue = (rank: string) => ({
    key: "chief.queue",
    value: { items: { approval: { rank, why: "Can wait", at } } },
  });
  try {
    notifications.snapshot({ interaction: [approval], settings: [queue("later")] });
    expect(fake.notices).toHaveLength(0);
    notifications.event("settings", queue("now"));
    expect(fake.notices).toHaveLength(1);
    notifications.event("settings", queue("later"));
    expect(fake.notices[0]?.closed).toBe(1);
  } finally {
    notifications.close();
  }
});

it("shows each notice from the main agent once, under its name, and never while you read its chat", () => {
  let focused: string | undefined;
  const notifications = desktopNotifications({
    focusedThread: () => focused,
    open: vi.fn(),
    failed: vi.fn(),
  });
  const notice = (id: string, threadId = "chief") => ({
    id,
    threadId,
    kind: "note",
    seq: 1,
    body: { code: "chief_notify", text: "The deploy needs your OK." },
    createdAt: at,
    updatedAt: at,
  });
  try {
    notifications.snapshot({ settings: [{ key: "chief.name", value: "Atlas" }] });
    notifications.event("item", { ...notice("one"), body: { code: "other", text: "x" } });
    expect(fake.notices).toHaveLength(0);
    notifications.event("item", notice("one"));
    notifications.event("item", notice("one"));
    expect(fake.notices.map((row) => row.options)).toEqual([
      expect.objectContaining({ title: "Atlas", body: "Open Zoltbot to read it." }),
    ]);
    // Reading the chat takes it down, and a later notice there stays quiet.
    focused = "chief";
    notifications.tick();
    expect(fake.notices[0]?.closed).toBe(1);
    notifications.event("item", notice("two"));
    expect(fake.notices).toHaveLength(1);
  } finally {
    notifications.close();
  }
});
