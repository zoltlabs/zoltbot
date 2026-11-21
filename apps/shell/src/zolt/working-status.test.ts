import { describe, expect, it } from "vitest";
import type { Snapshot } from "./daemon-client";
import { workingStatus } from "./working-status";

const snapshot = (status?: unknown, turn = "running") =>
  ({
    entities: {
      turn: [{ id: "t1", threadId: "c1", status: turn }],
      settings: status ? [{ key: "chat.status.c1", value: status }] : [],
    },
  }) as unknown as Snapshot;
const tool = (body: Record<string, unknown>) => ({
  id: "i1",
  kind: "tool",
  turnId: "t1",
  body: { status: "running", ...body },
});

describe("workingStatus", () => {
  it("is null when no turn runs", () => {
    expect(workingStatus(snapshot(undefined, "completed"), "c1", [])).toBeNull();
  });

  it("prefers the agent's own words for the running turn", () => {
    const own = { turnId: "t1", text: "Reading the invoices", at: "now" };
    expect(workingStatus(snapshot(own), "c1", [tool({ kind: "search" })])).toBe(
      "Reading the invoices",
    );
    const old = { turnId: "t0", text: "Old line", at: "then" };
    expect(workingStatus(snapshot(old), "c1", [])).toBe("Working");
  });

  it("derives a line from the running tool", () => {
    const line = (body: Record<string, unknown>) => workingStatus(snapshot(), "c1", [tool(body)]);
    expect(line({ kind: "execute", check: "tests" })).toBe("Running tests");
    expect(line({ kind: "edit", locations: [{ path: "src/app/main.ts" }] })).toBe(
      "Editing main.ts",
    );
    expect(line({ kind: "search" })).toBe("Searching");
    expect(line({ kind: "execute" })).toBe("Running a command");
    expect(line({ kind: "think" })).toBe("Working");
    expect(line({ kind: "search", status: "ok" })).toBe("Working");
  });
});
