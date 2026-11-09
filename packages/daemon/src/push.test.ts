import { expect, it } from "vitest";
import { chiefFixture } from "./chief/test-fixture.js";
import type { DeviceBook } from "./devices.js";
import { pushNotifier } from "./push.js";
import type { RelayLink } from "./relay-link.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("sends no push for requests the main agent ranked for later", async () => {
  const { f, request, call } = await chiefFixture();
  const sent: Record<string, unknown>[] = [];
  const link = { status: "online", send: (message: Record<string, unknown>) => sent.push(message) };
  const notifier = pushNotifier({
    store: f.store,
    devices: { paired: () => [{ id: "phone" }] } as unknown as DeviceBook,
    link: () => link as unknown as RelayLink,
    delayMs: 1,
  });
  try {
    let before = f.store.lastSeq();
    const quiet = request("worker", { type: "approval", title: "Rename a test" });
    await call("chief_triage", {
      items: [{ interactionId: quiet, rank: "later", why: "Cosmetic" }],
    });
    notifier.observe(f.store.eventsSince(before));
    await settle();
    expect(sent).toEqual([]);
    before = f.store.lastSeq();
    request("worker", { type: "approval", title: "Deploy" });
    notifier.observe(f.store.eventsSince(before));
    await settle();
    // The later one is left out of the count too.
    expect(sent).toMatchObject([{ t: "push", deviceId: "phone", kind: "needs_you", count: 1 }]);
  } finally {
    notifier.close();
    f.close();
  }
});

it("skips a phone that turned its own pushes off", async () => {
  const { f, request, change } = await chiefFixture();
  const sent: Record<string, unknown>[] = [];
  const link = { status: "online", send: (message: Record<string, unknown>) => sent.push(message) };
  const notifier = pushNotifier({
    store: f.store,
    devices: { paired: () => [{ id: "phone" }, { id: "ipad" }] } as unknown as DeviceBook,
    link: () => link as unknown as RelayLink,
    delayMs: 1,
  });
  try {
    change({
      type: "create",
      kind: "settings",
      value: { key: "mobile.ipad.notifyNeedsYou", value: false },
    });
    const before = f.store.lastSeq();
    request("worker", { type: "approval", title: "Deploy" });
    notifier.observe(f.store.eventsSince(before));
    await settle();
    expect(sent).toMatchObject([{ deviceId: "phone", kind: "needs_you" }]);
  } finally {
    notifier.close();
    f.close();
  }
});
