import { expect, it } from "vitest";
import { updateRows, visibleUpdates } from "./update-data.js";

const row = {
  definitionId: "antigravity",
  displayName: "Antigravity",
  installed: "1.5.1",
  latest: "1.5.2",
  command: ["agy", "update"],
};
it("keeps well formed update rows and hides only the dismissed version", () => {
  expect(updateRows({ updates: [row, { definitionId: "broken" }] })).toEqual([row]);
  expect(updateRows(undefined)).toEqual([]);
  expect(visibleUpdates([row], { antigravity: "1.5.2" })).toEqual([]);
  expect(visibleUpdates([row], { antigravity: "1.5.1" })).toEqual([row]);
  expect(visibleUpdates([row], undefined)).toEqual([row]);
});
