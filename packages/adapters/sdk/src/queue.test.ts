import { expect, it } from "vitest";
import { AsyncQueue } from "./queue.js";

it("applies backpressure and preserves ordering", async () => {
  const queue = new AsyncQueue<number>(1);
  await queue.push(1);
  let pushed = false;
  const blocked = queue.push(2).then(() => {
    pushed = true;
  });
  await Promise.resolve();
  expect(pushed).toBe(false);
  const iterator = queue[Symbol.asyncIterator]();
  expect(await iterator.next()).toEqual({ value: 1, done: false });
  await blocked;
  expect(await iterator.next()).toEqual({ value: 2, done: false });
  queue.close();
  expect((await iterator.next()).done).toBe(true);
});
it("close releases blocked consumers and producers", async () => {
  const queue = new AsyncQueue<number>();
  const read = queue[Symbol.asyncIterator]().next();
  queue.close();
  expect((await read).done).toBe(true);
  const full = new AsyncQueue<number>(1);
  await full.push(1);
  const blocked = full.push(2);
  full.close();
  await blocked;
});
