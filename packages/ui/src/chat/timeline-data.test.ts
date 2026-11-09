import { describe, expect, it } from "vitest";
import {
  modeLabel,
  nextMode,
  sessionModes,
  sessionSafeModes,
  widensPermissions,
} from "./mode-data.js";
import { backgroundTasks, rewindPreview } from "./parity-data.js";
import { groupTimeline, planEntries, planProgress, stableNested } from "./timeline-data.js";

const row = (id: string, kind: string, body: Record<string, unknown> = {}) => ({ id, kind, body });
const ids = (rows: { id?: unknown }[]) => rows.map((value) => value.id);

describe("timeline grouping", () => {
  it("nests subagent rows under their parent by item id or native id", () => {
    const groups = groupTimeline([
      row("u", "user"),
      row("agent", "tool", { kind: "agent", nativeItemId: "toolu_1" }),
      row("child-tool", "tool", { kind: "read", parentItemId: "toolu_1" }),
      row("child-message", "message", { parentItemId: "agent" }),
      row("grandchild", "tool", { parentItemId: "child-tool" }),
      row("m", "message"),
    ]);
    expect(ids(groups.top)).toEqual(["u", "agent", "m"]);
    expect(ids(groups.nested.get("agent") ?? [])).toEqual(["child-tool", "child-message"]);
    expect(ids(groups.nested.get("child-tool") ?? [])).toEqual(["grandchild"]);
  });
  it("nests under any tool kind, so a provider's nested calls stay reachable", () => {
    const groups = groupTimeline([
      row("parent", "tool", { kind: "other", nativeItemId: "call-1" }),
      row("child", "tool", { kind: "execute", parentItemId: "call-1" }),
      row("ask", "tool", { kind: "other", interactive: true }),
      row("ask-child", "message", { parentItemId: "ask" }),
    ]);
    expect(ids(groups.top)).toEqual(["parent", "ask"]);
    expect(ids(groups.nested.get("parent") ?? [])).toEqual(["child"]);
    expect(ids(groups.nested.get("ask") ?? [])).toEqual(["ask-child"]);
  });
  it("keeps orphans and cycles at the top level so nothing disappears", () => {
    const groups = groupTimeline([
      row("orphan", "message", { parentItemId: "missing" }),
      row("a", "tool", { parentItemId: "b" }),
      row("b", "tool", { parentItemId: "a" }),
      row("self", "tool", { parentItemId: "self" }),
    ]);
    expect(ids(groups.top)).toEqual(["orphan", "a", "b", "self"]);
    expect(groups.nested.size).toBe(0);
  });
  it("selects the latest top level plan and folds consecutive plan updates", () => {
    const groups = groupTimeline([
      row("p1", "plan", { entries: [{ step: "a", status: "pending" }] }),
      row("p2", "plan", { entries: [{ step: "a", status: "in_progress" }] }),
      row("m", "message"),
      row("agent", "tool", { kind: "agent" }),
      row("sub-plan", "plan", { parentItemId: "agent" }),
      row("p3", "plan", { entries: [{ step: "a", status: "completed" }] }),
    ]);
    expect(ids(groups.top)).toEqual(["p2", "m", "agent", "p3"]);
    expect(groups.latestPlan?.id).toBe("p3");
  });
  it("keeps nested lists referentially stable while other rows change", () => {
    const parent = row("p", "tool", { kind: "agent" });
    const child = row("c", "tool", { parentItemId: "p" });
    const first = groupTimeline([parent, child]).nested;
    const streamed = groupTimeline([parent, child, row("m", "message")]).nested;
    expect(stableNested(first, streamed)).toBe(first);
    const grown = groupTimeline([parent, child, row("d", "message", { parentItemId: "p" })]).nested;
    const next = stableNested(first, grown);
    expect(next).not.toBe(first);
    expect(ids(next.get("p") ?? [])).toEqual(["c", "d"]);
    expect(stableNested(undefined, grown)).toBe(grown);
  });
  it("reads plan entries and progress defensively", () => {
    const entries = planEntries(
      row("p", "plan", {
        entries: [
          { step: "one", status: "completed" },
          { step: "two", status: "in_progress" },
          { step: "three", status: "bogus" },
          { status: "completed" },
        ],
      }),
    );
    expect(entries.map((entry) => entry.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(planProgress(entries)).toMatchObject({ done: 1, total: 3, current: { step: "two" } });
  });
});

describe("permission modes", () => {
  it("labels known modes and shows unknown ids as reported", () => {
    expect(modeLabel("default")).toBe("Supervised");
    expect(modeLabel("acceptEdits")).toBe("Auto-accept edits");
    expect(modeLabel("plan")).toBe("Plan mode");
    expect(modeLabel("bypassPermissions")).toBe("Full access");
    expect(modeLabel("auto")).toBe("Auto");
    expect(modeLabel("readOnly")).toBe("readOnly");
  });
  it("treats every mode outside the reported safe list as widening", () => {
    const safe = sessionSafeModes({ safeModes: ["default", "plan", 4] });
    expect(safe).toEqual(["default", "plan"]);
    expect(widensPermissions("plan", safe)).toBe(false);
    expect(widensPermissions("acceptEdits", safe)).toBe(true);
    expect(widensPermissions("readOnly", safe)).toBe(true);
    expect(sessionSafeModes({})).toBeUndefined();
    expect(widensPermissions("default", undefined)).toBe(true);
  });
  it("cycles only safe modes", () => {
    const modes = sessionModes({
      modes: ["default", "acceptEdits", "plan", "bypassPermissions", 3],
    });
    expect(modes).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    const safe = ["default", "acceptEdits", "plan"];
    expect(nextMode(modes, "default", safe)).toBe("acceptEdits");
    expect(nextMode(modes, "plan", safe)).toBe("default");
    expect(nextMode(modes, "bypassPermissions", safe)).toBe("default");
    expect(nextMode(modes, "default", ["default"])).toBeUndefined();
    expect(nextMode(modes, "default", undefined)).toBeUndefined();
  });
});

describe("session parity data", () => {
  it("parses background tasks and drops malformed ones", () => {
    expect(
      backgroundTasks({
        background: [
          { id: "t1", kind: "shell", description: "npm run dev", state: "running" },
          { id: "t2", state: "completed", summary: "Done" },
          { id: "t3", state: "weird" },
          null,
        ],
      }),
    ).toEqual([
      { id: "t1", kind: "shell", description: "npm run dev", state: "running" },
      {
        id: "t2",
        kind: "other",
        description: "Background task",
        state: "completed",
        summary: "Done",
      },
    ]);
  });
  it("normalizes rewind previews", () => {
    expect(
      rewindPreview({ canRewind: true, files: ["a", 2], insertions: 3, deletions: -1 }),
    ).toEqual({ canRewind: true, files: ["a"], insertions: 3 });
    expect(rewindPreview(undefined)).toEqual({ canRewind: false, files: [] });
  });
});
