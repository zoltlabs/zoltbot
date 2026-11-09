import { expect, it } from "vitest";
import { NativeWriters } from "./writers.js";

it("reserves a native writer before asynchronous setup and releases idempotently", () => {
  const writers = new NativeWriters();
  const release = writers.acquire("definition/home/native");
  expect(() => writers.acquire("definition/home/native")).toThrow("native_session_in_use");
  release();
  release();
  const second = writers.acquire("definition/home/native");
  release();
  expect(() => writers.acquire("definition/home/native")).toThrow("native_session_in_use");
  second();
});
