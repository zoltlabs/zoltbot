import { describe, expect, it } from "vitest";
import { cleanStatus, nextStatus, statusLine, toolStatus } from "./status-line.js";

describe("status line", () => {
  it("prefers the agent's own words for this turn", () => {
    const stored = { turnId: "t1", text: "Reading the invoices", at: "" };
    expect(statusLine({ stored, turnId: "t1", tools: [] })).toBe("Reading the invoices");
    // A status from an earlier turn no longer applies.
    expect(statusLine({ stored, turnId: "t2", tools: [] })).toBe("Working");
  });

  it("derives a line from the running tool", () => {
    expect(toolStatus({ kind: "execute", check: "tests" })).toBe("Running tests");
    expect(toolStatus({ kind: "edit", locations: [{ path: "/repo/src/app.ts" }] })).toBe(
      "Editing app.ts",
    );
    expect(toolStatus({ kind: "edit" })).toBe("Editing files");
    expect(toolStatus({ kind: "search" })).toBe("Searching");
    expect(toolStatus({ kind: "execute" })).toBe("Running a command");
    expect(toolStatus({ kind: "think" })).toBe("Working");
    expect(toolStatus(undefined)).toBe("Working");
    const tools = [
      { kind: "tool", turnId: "t", body: { kind: "read", status: "ok" } },
      { kind: "tool", turnId: "t", body: { kind: "search", status: "running" } },
      { kind: "tool", turnId: "old", body: { kind: "edit", status: "running" } },
    ];
    expect(statusLine({ stored: undefined, turnId: "t", tools })).toBe("Searching");
  });

  it("keeps a status to one short line", () => {
    expect(cleanStatus("  Reading\n the   invoices ")).toBe("Reading the invoices");
    expect(cleanStatus("x".repeat(80))).toHaveLength(60);
  });

  it("changes at most once every 3 seconds", () => {
    const first = nextStatus(undefined, "Reading", 0);
    expect(first).toEqual({ text: "Reading", at: 0 });
    expect(nextStatus(first, "Reading", 500)).toBe(first);
    expect(nextStatus(first, "Editing", 1000)).toEqual({ text: "Reading", at: 0, waitMs: 2000 });
    expect(nextStatus(first, "Editing", 3000)).toEqual({ text: "Editing", at: 3000 });
  });
});
