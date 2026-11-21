import { describe, expect, it } from "vitest";
import { memoryStore } from "./link-store.js";
import {
  addMac,
  chooseMac,
  loadMacs,
  macLimit,
  removeMac,
  renameMac,
  saveMacs,
  seenEveryMs,
  seenMac,
} from "./macs.js";

const now = new Date("2026-11-20T10:00:00.000Z");
const mac = (n: number) => ({
  relay: "wss://relay.example.test",
  macId: `mac${n}`,
  macKey: `key${n}`,
  name: `Example Mac ${n}`,
});

describe("saved Macs", () => {
  it("moves the single v1 Mac into the list once, and drops the old item", async () => {
    const store = memoryStore();
    store.values.set("zoltbot.link.mac.v1", JSON.stringify(mac(1)));
    const first = await loadMacs(store, now);
    expect(first).toEqual({
      active: "mac1",
      macs: [{ ...mac(1), label: "Example Mac 1", pairedAt: now.toISOString() }],
    });
    expect(store.values.has("zoltbot.link.mac.v1")).toBe(false);
    expect(await loadMacs(store, new Date(now.getTime() + 1000))).toEqual(first);
  });

  it("starts empty, and ignores a broken or partial entry", async () => {
    const store = memoryStore();
    expect(await loadMacs(store)).toEqual({ macs: [] });
    store.values.set("zoltbot.link.mac.v1", JSON.stringify({ relay: "wss://x", macId: "m" }));
    expect(await loadMacs(store)).toEqual({ macs: [] });
    store.values.set("zoltbot.link.macs.v2", "{not json");
    expect(await loadMacs(store)).toEqual({ macs: [] });
    store.values.set(
      "zoltbot.link.macs.v2",
      JSON.stringify({ active: "gone", macs: [mac(1), { macId: "half" }, mac(1), mac(2)] }),
    );
    const read = await loadMacs(store, now);
    expect(read.active).toBe("mac1");
    expect(read.macs.map((row) => row.macId)).toEqual(["mac1", "mac2"]);
  });

  it("adds, re-pairs, renames, chooses and forgets", async () => {
    let value = addMac({ macs: [] }, mac(1), now);
    value = addMac(value, mac(2), now);
    expect(value.active).toBe("mac2");
    value = renameMac(value, "mac1", "  Studio\n Mac  ");
    expect(value.macs[0]?.label).toBe("Studio Mac");
    expect(renameMac(value, "mac1", "   ")).toBe(value);
    // Pairing the same Mac again replaces its keys and keeps the name the person gave it.
    value = addMac(value, { ...mac(1), macKey: "new" }, now);
    expect(value.macs).toHaveLength(2);
    expect(value.macs[0]).toMatchObject({ macKey: "new", label: "Studio Mac" });
    expect(value.active).toBe("mac1");
    value = chooseMac(value, "mac2");
    expect(chooseMac(value, "nope")).toBe(value);
    value = removeMac(value, "mac2");
    expect(value).toMatchObject({ active: "mac1", macs: [{ macId: "mac1" }] });
    expect(removeMac(value, "mac1")).toEqual({ macs: [] });

    const store = memoryStore();
    await saveMacs(store, value);
    expect(await loadMacs(store)).toEqual(value);
  });

  it("caps the list", () => {
    let value = { macs: [] } as ReturnType<typeof addMac>;
    for (let n = 0; n < macLimit; n++) value = addMac(value, mac(n), now);
    expect(() => addMac(value, mac(99), now)).toThrow("mac_limit");
    expect(addMac(value, mac(0), now).macs).toHaveLength(macLimit);
  });

  it("marks a Mac seen at most once an hour", () => {
    const value = addMac({ macs: [] }, mac(1), now);
    const seen = seenMac(value, "mac1", now);
    expect(seen?.macs[0]?.lastSeenAt).toBe(now.toISOString());
    if (!seen) throw new Error();
    expect(seenMac(seen, "mac1", new Date(now.getTime() + 60_000))).toBeUndefined();
    expect(seenMac(seen, "mac1", new Date(now.getTime() + seenEveryMs))).toBeDefined();
    expect(seenMac(seen, "other", now)).toBeUndefined();
  });
});
