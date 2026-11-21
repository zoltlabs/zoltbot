import { expect, it } from "vitest";
import { activityNotifier } from "./activity-push.js";
import { chiefFixture } from "./chief/test-fixture.js";
import type { DeviceBook } from "./devices.js";
import type { RelayLink } from "./relay-link.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("sends each phone the counts once per change, and only to a relay that delivers them", async () => {
  const { f, request } = await chiefFixture();
  const sent: Record<string, unknown>[] = [];
  let features = ["liveactivity"];
  const link = {
    status: "online",
    send: (message: Record<string, unknown>) => sent.push(message),
    delivers: (kind: string) => features.includes(kind),
  };
  const notifier = activityNotifier({
    store: f.store,
    devices: { paired: () => [{ id: "phone" }] } as unknown as DeviceBook,
    link: () => link as unknown as RelayLink,
    delayMs: 1,
  });
  try {
    let before = f.store.lastSeq();
    request("worker", { type: "approval", title: "Deploy the private thing" });
    notifier.observe(f.store.eventsSince(before));
    await settle();
    expect(sent).toMatchObject([{ t: "activity", deviceId: "phone", working: 0, needsYou: 1 }]);
    expect(sent[0]).toHaveProperty("topId");
    // Counts and an id only: the request's title never leaves.
    expect(JSON.stringify(sent)).not.toContain("Deploy");
    notifier.observe(f.store.eventsSince(before));
    await settle();
    expect(sent).toHaveLength(1);

    features = [];
    before = f.store.lastSeq();
    request("worker", { type: "approval", title: "Another" });
    notifier.observe(f.store.eventsSince(before));
    await settle();
    expect(sent).toHaveLength(1);
  } finally {
    notifier.close();
    f.close();
  }
});
