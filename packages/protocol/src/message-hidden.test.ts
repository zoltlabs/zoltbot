import { expect, it } from "vitest";
import {
  MAX_HIDDEN_MESSAGES,
  messageHiddenKey,
  messageHiddenThread,
  readHiddenMessages,
  withHiddenMessage,
} from "./message-hidden.js";

it("keys a row by chat", () => {
  expect(messageHiddenThread(messageHiddenKey("t1"))).toBe("t1");
  expect(messageHiddenThread("chat.pins.t1")).toBeUndefined();
  expect(messageHiddenThread("chat.hidden.")).toBeUndefined();
});

it("hides and shows messages once each", () => {
  expect(readHiddenMessages(["a", "a", 3, "", "b"])).toEqual(["a", "b"]);
  expect(readHiddenMessages("nope")).toEqual([]);
  expect(withHiddenMessage(["a"], "b", true)).toEqual(["a", "b"]);
  expect(withHiddenMessage(["a", "b"], "a", true)).toEqual(["b", "a"]);
  expect(withHiddenMessage(["a", "b"], "a", false)).toEqual(["b"]);
  expect(withHiddenMessage(["a", "b"], "c", false)).toEqual(["a", "b"]);
});

it("keeps the newest hidden messages past the limit", () => {
  const full = Array.from({ length: MAX_HIDDEN_MESSAGES }, (_, i) => `m${i}`);
  const next = withHiddenMessage(full, "new", true);
  expect(next).toHaveLength(MAX_HIDDEN_MESSAGES);
  expect(next.at(-1)).toBe("new");
  expect(next[0]).toBe("m1");
});
