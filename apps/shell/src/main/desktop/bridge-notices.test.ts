import { describe, expect, it } from "vitest";
import { bridgeRefusalNotice } from "./bridge-notices";

const now = Date.parse("2026-11-21T10:00:00Z");
const row = (at: string, place = { id: "C1", label: "#support" }) => ({
  key: "bridge.refused.b1",
  value: [{ id: "r1", at, person: { id: "U9", name: "Sam" }, place }],
});

describe("bridge refusal notices", () => {
  it("names who wrote and where", () => {
    expect(bridgeRefusalNotice(row("2026-11-21T09:59:30Z"), now)).toEqual({
      id: "r1",
      threadId: "bridges",
      text: "Sam isn’t on the list for #support.",
    });
    expect(
      bridgeRefusalNotice(row("2026-11-21T09:59:30Z", { id: "dm", label: "" }), now)?.text,
    ).toBe("Sam isn’t on the list for direct messages.");
  });

  it("skips old refusals and other rows", () => {
    expect(bridgeRefusalNotice(row("2026-11-21T09:00:00Z"), now)).toBeUndefined();
    expect(bridgeRefusalNotice({ key: "bridge.status.b1", value: [] }, now)).toBeUndefined();
    expect(bridgeRefusalNotice({ key: "bridge.refused.b1", value: [] }, now)).toBeUndefined();
  });
});
