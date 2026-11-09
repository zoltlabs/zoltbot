import { expect, it } from "vitest";
import { deviceError, deviceRows, lastSeen, qrPath, spacedCode } from "./devices-view.js";

it("splits phones waiting for approval from paired ones and hides removed ones", () => {
  const rows = deviceRows([
    { id: "b", name: "Work iPhone", state: "paired", archived: false },
    { id: "a", name: "Home iPhone", state: "paired", archived: false },
    { id: "c", name: "New iPhone", state: "pending", confirmCode: "123456", archived: false },
    { id: "d", name: "Old iPhone", state: "revoked", archived: true },
  ]);
  expect(rows.paired.map((row) => row.id)).toEqual(["a", "b"]);
  expect(rows.pending.map((row) => row.id)).toEqual(["c"]);
  expect(spacedCode("123456")).toBe("123 456");
});

it("says when a phone was last seen", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  expect(lastSeen(undefined, now)).toBe("Not seen yet");
  expect(lastSeen("2026-11-03T11:59:50Z", now)).toBe("Last seen just now");
  expect(lastSeen("2026-11-03T11:46:00Z", now)).toBe("Last seen 14 min ago");
  expect(lastSeen("2026-11-03T09:00:00Z", now)).toBe("Last seen 3 h ago");
});

it("explains daemon errors in plain words and draws a square code", () => {
  expect(deviceError(new Error("relay_offline: x"))).toMatch(/cannot reach the relay/);
  expect(deviceError(new Error("relay_not_set: x"))).toBe("Add a relay address first.");
  const { path, size } = qrPath("zoltbot://pair?v=1");
  expect(size).toBeGreaterThan(20);
  expect(path.startsWith("M")).toBe(true);
});
