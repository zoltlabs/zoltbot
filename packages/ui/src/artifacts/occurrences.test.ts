import { expect, it } from "vitest";
import { artifactTimeline } from "./occurrences.js";

it("anchors deduplicated version occurrences to loaded turns, preserves historical groups and stable keys", () => {
  const a = { id: "a", currentVersionId: "v3", state: "active", threadId: "original-chat" };
  const versions = [
    { id: "v1", artifactId: "a", turnId: "t1", number: 1 },
    { id: "v2", artifactId: "a", turnId: "t1", number: 2 },
    { id: "v3", artifactId: "a", turnId: "t2", number: 3 },
  ];
  const items = [
    { id: "m1", turnId: "t1" },
    { id: "m2", turnId: "t2" },
  ];
  const rows = artifactTimeline(items, [a], [...versions, versions[0] as (typeof versions)[0]]);
  expect(rows.map((r) => r.key)).toEqual([
    "message:m1",
    "artifact:t1:a",
    "message:m2",
    "artifact:t2:a",
  ]);
  expect(rows[1]).toMatchObject({ versions: [{ id: "v1" }, { id: "v2" }] });
  const streamed = artifactTimeline([...items, { id: "m3", turnId: "t2" }], [a], versions);
  expect(streamed.at(-1)?.key).toBe("artifact:t2:a");
  expect(artifactTimeline(items.slice(1), [a], versions).map((r) => r.key)).toEqual([
    "message:m2",
    "artifact:t2:a",
  ]);
  expect(artifactTimeline(items, [{ ...a, state: "archived" }], versions)).toHaveLength(2);
});
