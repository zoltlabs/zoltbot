import type { Interaction } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { inQuietHours, NotificationPlanner, notificationChoices } from "./notifications.js";

const at = Date.parse("2026-10-28T12:00:00Z");
const request: Interaction = {
  id: "request",
  agentId: "profile",
  threadId: "thread",
  type: "question",
  version: 1,
  state: "pending",
  items: [{ id: "q", prompt: "synthetic-private-prompt", secret: true }],
  chain: [],
  urgency: "blocking",
  createdAt: new Date(at).toISOString(),
};
const context = {
  focusedThreadId: undefined,
  idle: false,
  previews: false,
  enabled: true,
  agentNames: new Map([["profile", "Builder"]]),
};
it("uses a stable key, hides private previews even with preview opt in, and withdraws resolved requests", () => {
  const planner = new NotificationPlanner();
  const first = planner.reconcile([request], { ...context, previews: true }, at);
  expect(first).toEqual([
    {
      action: "show",
      key: "interaction:request",
      interactionId: "request",
      threadId: "thread",
      title: "Builder needs an answer",
      body: "A private answer is requested. Open Zoltbot to respond.",
      silent: false,
    },
  ]);
  expect(JSON.stringify(first)).not.toContain(request.items[0]?.prompt);
  expect(planner.reconcile([request], context, at + 1)).toEqual([]);
  expect(planner.reconcile([{ ...request, state: "expired" }], context, at + 2)).toEqual([
    { action: "withdraw", key: "interaction:request" },
  ]);
});
it("reminds at five minutes, thirty minutes, then hourly only while idle", () => {
  const planner = new NotificationPlanner();
  planner.reconcile([request], context, at);
  const tick = (minutes: number, idle = true) =>
    planner.reconcile([request], { ...context, idle }, at + minutes * 60000);
  expect(tick(4)).toEqual([]);
  expect(tick(5, false)).toEqual([]);
  expect(tick(6)).toHaveLength(1);
  expect(tick(29)).toEqual([]);
  expect(tick(30)).toHaveLength(1);
  expect(tick(89)).toEqual([]);
  expect(tick(90)).toHaveLength(1);
  expect(tick(149)).toEqual([]);
  expect(tick(150)).toHaveLength(1);
});
it("suppresses a thread being read, coalesces missed reminders, and keeps background requests silent", () => {
  const planner = new NotificationPlanner();
  expect(planner.reconcile([request], { ...context, focusedThreadId: "thread" }, at)).toEqual([]);
  expect(planner.reconcile([request], context, at + 1000)).toEqual([]);
  const overdue = planner.reconcile(
    [{ ...request, urgency: "background" }],
    { ...context, idle: true },
    at + 180 * 60000,
  );
  expect(overdue).toHaveLength(1);
  expect(overdue[0]).toMatchObject({ silent: true });
  expect(planner.reconcile([request], { ...context, idle: true }, at + 181 * 60000)).toEqual([]);
});
it("uses generic public previews by default and withdraws when disabled or a snapshot removes a request", () => {
  const planner = new NotificationPlanner();
  const publicRequest = { ...request, items: [{ id: "q", prompt: "Public question" }] };
  expect(planner.reconcile([publicRequest], context, at)[0]).toMatchObject({
    body: "Open Zoltbot to review this request.",
  });
  expect(planner.reconcile([publicRequest], { ...context, enabled: false }, at + 1)).toEqual([
    { action: "withdraw", key: "interaction:request" },
  ]);
  expect(
    planner.reconcile([publicRequest], { ...context, previews: true, idle: true }, at + 300000)[0],
  ).toMatchObject({ body: "Public question" });
  expect(planner.reconcile([], context, at + 300001)).toEqual([
    { action: "withdraw", key: "interaction:request" },
  ]);
});
it("suppresses notices during quiet hours and coalesces a missed reminder when they end", () => {
  const planner = new NotificationPlanner();
  planner.reconcile([request], context, at);
  expect(
    planner.reconcile([request], { ...context, quiet: true, idle: true }, at + 300000),
  ).toEqual([{ action: "withdraw", key: "interaction:request" }]);
  expect(
    planner.reconcile([request], { ...context, quiet: true, idle: true }, at + 3600000),
  ).toEqual([]);
  expect(
    planner.reconcile([request], { ...context, quiet: false, idle: true }, at + 3600001),
  ).toHaveLength(1);
  expect(
    planner.reconcile([request], { ...context, quiet: false, idle: true }, at + 3600002),
  ).toEqual([]);
  const fresh = new NotificationPlanner();
  expect(fresh.reconcile([request], { ...context, quiet: true }, at)).toEqual([]);
  expect(fresh.reconcile([request], context, at + 1)).toHaveLength(1);
});
it("matches quiet hour windows across midnight in the chosen timezone with half open boundaries", () => {
  const setting = { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" };
  expect(inQuietHours(setting, Date.parse("2026-10-28T21:59:00Z"))).toBe(false);
  expect(inQuietHours(setting, Date.parse("2026-10-28T22:00:00Z"))).toBe(true);
  expect(inQuietHours(setting, Date.parse("2026-10-29T06:59:00Z"))).toBe(true);
  expect(inQuietHours(setting, Date.parse("2026-10-29T07:00:00Z"))).toBe(false);
  expect(
    inQuietHours({ ...setting, timeZone: "Asia/Kolkata" }, Date.parse("2026-10-28T16:30:00Z")),
  ).toBe(true);
  expect(inQuietHours({ ...setting, enabled: false }, at)).toBe(false);
  expect(inQuietHours({ ...setting, start: "29:00" }, at)).toBe(false);
  expect(inQuietHours({ ...setting, timeZone: "invalid" }, at)).toBe(false);
  expect(inQuietHours({ ...setting, start: "07:00" }, at)).toBe(false);
});

it("uses daytime quiet windows and repeated daylight saving hours without skipping either occurrence", () => {
  const daytime = { enabled: true, start: "09:00", end: "17:00", timeZone: "UTC" };
  expect(inQuietHours(daytime, Date.parse("2026-10-28T09:00:00Z"))).toBe(true);
  expect(inQuietHours(daytime, Date.parse("2026-10-28T17:00:00Z"))).toBe(false);
  const repeated = { enabled: true, start: "01:00", end: "02:00", timeZone: "America/New_York" };
  expect(inQuietHours(repeated, Date.parse("2026-11-01T05:30:00Z"))).toBe(true);
  expect(inQuietHours(repeated, Date.parse("2026-11-01T06:30:00Z"))).toBe(true);
  expect(inQuietHours(repeated, Date.parse("2026-11-01T07:00:00Z"))).toBe(false);
});
it("offers only advertised once choices for a simple public approval", () => {
  const approval: Interaction = {
    ...request,
    type: "approval",
    items: [
      { id: "approve", prompt: "Allow?", choices: [{ id: "allow_once" }, { id: "reject_once" }] },
    ],
  };
  expect(notificationChoices(approval)).toEqual(["allow_once", "reject_once"]);
  expect(
    notificationChoices({
      ...approval,
      items: [
        {
          id: "approve",
          prompt: "Allow?",
          secret: true,
          choices: [{ id: "allow_once" }, { id: "reject_once" }],
        },
      ],
    }),
  ).toEqual([]);
  expect(notificationChoices({ ...approval, state: "answered" })).toEqual([]);
  expect(
    notificationChoices({ ...approval, context: { diffs: [{ path: "file", patch: "diff" }] } }),
  ).toEqual([]);
  expect(
    notificationChoices({
      ...approval,
      items: [{ id: "approve", prompt: "Allow?", choices: [{ id: "reject_once" }] }],
    }),
  ).toEqual(["reject_once"]);
  expect(notificationChoices(request)).toEqual([]);
});
