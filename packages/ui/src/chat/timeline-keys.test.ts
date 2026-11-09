import { expect, it } from "vitest";
import { createTimelineKeys } from "./timeline-keys.js";

it("retains measurement identity for streamed content but invalidates reordered or replaced rows", () => {
  const select = createTimelineKeys();
  const before = select([{ key: "message:a" }, { key: "message:b" }]);
  const streamed = select([{ key: "message:a" }, { key: "message:b" }]);
  expect(streamed).toBe(before);
  expect(streamed(1)).toBe("message:b");
  const reordered = select([{ key: "message:b" }, { key: "artifact:a" }]);
  expect(reordered).not.toBe(before);
  expect(reordered(1)).toBe("artifact:a");
  expect(before(1)).toBe("message:b");
  expect(select([{ key: "message:b" }])).not.toBe(reordered);
  expect(select([])(0)).toBe(0);
});
