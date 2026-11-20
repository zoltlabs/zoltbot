import { describe, expect, it } from "vitest";
import { moved } from "./queue-order";

describe("moved", () => {
  it("moves an id up, down and across the list", () => {
    expect(moved(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(moved(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("returns null when nothing would change", () => {
    expect(moved(["a", "b"], "a", -1)).toBeNull();
    expect(moved(["a", "b"], "b", 2)).toBeNull();
    expect(moved(["a", "b"], "a", 0)).toBeNull();
    expect(moved(["a", "b"], "x", 0)).toBeNull();
  });
});
