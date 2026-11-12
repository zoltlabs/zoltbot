import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown.js";
import { pushResponse, readPushTarget } from "./push.js";
import { sampleSnapshot } from "./sample.js";
import {
  latestPlan,
  modeError,
  modeLabel,
  modelState,
  modeState,
  modeWidens,
  runningBackground,
  threadSession,
} from "./session.js";
import { childSummary, interactionLine, toolTitle, transcript } from "./timeline.js";

const snapshot = sampleSnapshot(Date.parse("2026-11-03T12:00:00.000Z"));

describe("permission modes", () => {
  it("labels known modes and spells out unknown ones", () => {
    expect(["default", "acceptEdits", "plan", "bypassPermissions", "auto"].map(modeLabel)).toEqual([
      "Ask before edits",
      "Auto-accept edits",
      "Plan mode",
      "Bypass permissions",
      "Auto",
    ]);
    expect(modeLabel("read_only")).toBe("Read only");
    expect(modeLabel("fullAccess")).toBe("Full access");
  });
  it("treats every mode outside capabilities.safeModes as widening", () => {
    const acp = { capabilities: { modes: ["ask", "code", "yolo"], safeModes: ["ask", "code"] } };
    expect(modeWidens(acp, "code")).toBe(false);
    expect(modeWidens(acp, "yolo")).toBe(true);
    // Without the list, nothing is known to be safe.
    expect(modeWidens({ capabilities: { modes: ["default"] } }, "default")).toBe(true);
    expect(modeWidens(undefined, "plan")).toBe(true);
    expect(modeError(new Error("mac_only: session.setMode works only on the Mac"))).toBe(
      "Change this mode on your Mac.",
    );
    expect(modeError(new Error("unsupported_mode"))).toBe("unsupported_mode");
  });
  it("offers the session's modes and hides the chip without them", () => {
    const state = modeState(threadSession(snapshot, "thread-unit-settings"));
    expect(state?.current).toBe("plan");
    expect(state?.label).toBe("Plan mode");
    expect(state?.options.map((option) => option.mode)).toEqual(["default", "plan"]);
    expect(state?.macOnly).toBe(2);
    const unlisted = modeState({ capabilities: { modes: ["default", "plan"] }, mode: "plan" });
    expect(unlisted).toMatchObject({ label: "Plan mode", options: [], macOnly: 2 });
    expect(modeState(threadSession(snapshot, "thread-rate-limits"))).toBeUndefined();
    expect(modeState({ capabilities: { modes: ["default"] }, state: "closed" })).toBeUndefined();
    expect(modeState({ capabilities: { modes: ["default", "plan"] } })?.label).toBe(
      "Ask before edits",
    );
  });
  it("counts running background tasks", () => {
    expect(runningBackground(threadSession(snapshot, "thread-meal-search"))).toEqual([
      { id: "bg-dev", description: "pnpm dev --filter app", state: "running", summary: "" },
    ]);
    expect(runningBackground(undefined)).toEqual([]);
  });
});

describe("models", () => {
  it("offers the session's models and efforts, and says when a change waits or costs cache", () => {
    const session = threadSession(snapshot, "thread-meal-search");
    expect(modelState(snapshot, session)).toMatchObject({
      sessionId: "session-meal",
      current: "opus",
      label: "Opus 5.5",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      started: true,
      running: true,
    });
    expect(modelState(snapshot, threadSession(snapshot, "thread-rate-limits"))).toBeUndefined();
  });
  it("marks only sent messages as places a new chat can start from", () => {
    const rows = transcript(snapshot, "thread-meal-search");
    expect(rows[0]).toMatchObject({ kind: "user", turnId: "turn-meal" });
  });
});

describe("timeline", () => {
  it("pins the newest plan with progress", () => {
    expect(latestPlan(snapshot, "thread-unit-settings")).toMatchObject({
      done: 1,
      total: 3,
      current: "Write the plan",
    });
    expect(latestPlan(snapshot, "thread-meal-search")).toBeUndefined();
  });
  it("groups subagent steps and shows interactions as one compact line", () => {
    const rows = transcript(snapshot, "thread-unit-settings");
    expect(rows.map((row) => [row.kind, row.text])).toEqual([
      ["user", "Let people pick grams or ounces in Settings."],
      ["tool", "Delegated Explore unit handling"],
      ["interaction", "Proposed a plan · Waiting for you"],
    ]);
    const children = rows[1]?.children ?? [];
    expect(children.map((row) => row.text)).toEqual([
      "Searched grams",
      "Units are formatted in src/meals/units.ts.",
    ]);
    expect(childSummary(children)).toBe("2 steps");
  });
  it("labels interactive tools from their linked interaction, else from their title", () => {
    const tool = (id: string, seq: number, extra: object) => ({
      id,
      threadId: "x",
      turnId: "turn",
      seq,
      kind: "tool",
      body: { name: "Native", kind: "other", interactive: true, status: "running", ...extra },
    });
    const rows = transcript(
      {
        seq: 1,
        counters: {},
        entities: {
          item: [
            tool("linked", 1, { nativeItemId: "native-1" }),
            tool("titled", 2, { nativeItemId: "native-2", title: "Pick a database" }),
            tool("bare", 3, { status: "ok" }),
          ],
          interaction: [
            { id: "i1", threadId: "x", type: "plan", state: "pending", nativeRef: "native-1" },
          ],
        },
      },
      "x",
    );
    expect(rows.map((row) => [row.id, row.kind, row.text, row.pending])).toEqual([
      ["linked", "interaction", "Proposed a plan · Waiting for you", true],
      ["titled", "interaction", "Pick a database", true],
      ["bare", "interaction", "Native", false],
    ]);
  });
  it("counts before/after diffs on tool rows", () => {
    const rows = transcript(
      {
        seq: 1,
        counters: {},
        entities: {
          item: [
            {
              id: "e",
              threadId: "x",
              seq: 1,
              kind: "tool",
              body: {
                kind: "edit",
                status: "ok",
                title: "a.ts",
                diffs: [{ path: "a.ts", before: "old", after: "new\nmore" }],
              },
            },
          ],
        },
      },
      "x",
    );
    expect(rows[0]).toMatchObject({ text: "Edited a.ts", added: 2, removed: 1 });
  });
  it("describes resolved interactions and uses tool titles", () => {
    expect(
      interactionLine({ type: "plan", state: "answered", resolution: { action: "decline" } }),
    ).toBe("Proposed a plan · Sent back");
    expect(
      interactionLine({ type: "approval", state: "answered", resolution: { action: "accept" } }),
    ).toBe("Asked for approval · Allowed");
    expect(interactionLine({ type: "question", state: "cancelled" })).toBe(
      "Asked a question · Skipped",
    );
    expect(
      toolTitle({ body: { kind: "execute", status: "running", title: "npm test", input: {} } }),
    ).toBe("Running npm test");
    expect(toolTitle({ body: { kind: "other", name: "Thing", title: "Did a thing" } })).toBe(
      "Did a thing",
    );
  });
});

describe("approval notifications", () => {
  const data = { interactionId: "approve-tests", version: 3, threadId: "thread-meal-search" };
  it("answers from the action buttons and opens the thread on tap", () => {
    const target = readPushTarget({ categoryIdentifier: "approval", data });
    expect(pushResponse(target, "allow_once")).toEqual({
      kind: "answer",
      id: "approve-tests",
      version: 3,
      threadId: "thread-meal-search",
      answer: { action: "accept", choice: "allow_once" },
    });
    expect(pushResponse(target, "reject", "  use the fake ")).toMatchObject({
      answer: { action: "decline", choice: "reject_once", feedback: "use the fake" },
    });
    expect(pushResponse(target, "expo.modules.notifications.actions.DEFAULT")).toEqual({
      kind: "open",
      threadId: "thread-meal-search",
    });
  });
  it("does nothing when keys are missing", () => {
    expect(pushResponse(readPushTarget({ data: { threadId: "t" } }), "allow_once")).toEqual({
      kind: "none",
    });
    expect(
      pushResponse(
        readPushTarget({ categoryIdentifier: "approval", data: { interactionId: "i" } }),
        "allow_once",
      ),
    ).toEqual({ kind: "none" });
    expect(pushResponse(readPushTarget({ data: null }), "tap")).toEqual({ kind: "none" });
    expect(
      readPushTarget({ data: { body: { ...data, version: "2", category: "approval" } } }),
    ).toEqual({
      category: "approval",
      interactionId: "approve-tests",
      threadId: "thread-meal-search",
      version: 2,
    });
  });
});

describe("markdown", () => {
  it("reads headings, lists, checklists, code and inline marks", () => {
    const blocks = parseMarkdown(
      "## Plan\n1. Add **Units** row\n  - nested `code`\n- [x] done\n- [ ] todo\n\n```ts\nconst a = 1;\n```\n> note\n---\nPlain *text* [link](http://x)",
    );
    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "item",
      "item",
      "item",
      "item",
      "code",
      "quote",
      "rule",
      "paragraph",
    ]);
    expect(blocks[1]).toMatchObject({
      marker: "1.",
      depth: 0,
      text: [{ text: "Add " }, { text: "Units", bold: true }, { text: " row" }],
    });
    expect(blocks[2]).toMatchObject({ marker: "•", depth: 1 });
    expect(blocks[3]).toMatchObject({ checked: true });
    expect(blocks[4]).toMatchObject({ checked: false });
    expect(blocks[5]).toEqual({ type: "code", text: "const a = 1;" });
    expect(blocks[8]).toMatchObject({
      text: [
        { text: "Plain " },
        { text: "text", italic: true },
        { text: " " },
        { text: "link", href: "http://x" },
      ],
    });
  });
});
