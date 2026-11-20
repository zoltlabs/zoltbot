import { expect, it } from "vitest";
import {
  MAX_MESSAGE_PINS,
  messagePinsKey,
  messagePinsThread,
  readMessagePins,
  withMessagePin,
} from "./message-pins.js";

it("keys pins by chat", () => {
  expect(messagePinsKey("t1")).toBe("chat.pins.t1");
  expect(messagePinsThread("chat.pins.t1")).toBe("t1");
  expect(messagePinsThread("chat.pins.")).toBeUndefined();
  expect(messagePinsThread("chief.thread")).toBeUndefined();
});

it("reads stored pins newest first and drops bad rows", () => {
  expect(
    readMessagePins([
      { itemId: "a", pinnedAt: "2026-11-20T10:00:00Z" },
      { itemId: "b", pinnedAt: "2026-11-20T11:00:00Z" },
      { itemId: "a", pinnedAt: "2026-11-20T12:00:00Z" },
      { pinnedAt: "x" },
      null,
    ]).map((pin) => pin.itemId),
  ).toEqual(["b", "a"]);
  expect(readMessagePins("nope")).toEqual([]);
});

it("pins, keeps the first pin time, and unpins", () => {
  const one = withMessagePin(undefined, "a", true, "2026-11-20T10:00:00Z");
  expect(withMessagePin(one, "a", true, "2026-11-20T12:00:00Z")).toEqual(one);
  expect(withMessagePin(one, "a", false, "2026-11-20T12:00:00Z")).toEqual([]);
  const full = Array.from({ length: MAX_MESSAGE_PINS }, (_, i) => ({
    itemId: `m${i}`,
    pinnedAt: "",
  }));
  expect(() => withMessagePin(full, "new", true, "z")).toThrow("pin_limit");
});
