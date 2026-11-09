import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { at } from "../../../tools/fakes/src/runtime-fixture.js";
import { knowledgeReviewApi } from "./knowledge-review-api.js";
import { readTaint, refreshTaint, taintObserver } from "./knowledge-taint.js";
import { knowledgeWriteFixture } from "./knowledge-write-fixture.js";

const lesson = {
  op: "create",
  scope: "project",
  kind: "lesson",
  title: "Retry flaky downloads",
  body: "Downloads from the mirror need one retry.",
  evidence: [{ kind: "task", ref: "t" }],
  reason: "Seen twice",
};
let seq = 0;
async function withItem(kind: "tool" | "user", body: Record<string, unknown>) {
  const k = await knowledgeWriteFixture();
  k.change({
    type: "create",
    kind: "item",
    value: {
      id: `item-${++seq}`,
      threadId: "thread",
      ...(kind === "tool" ? { turnId: "turn" } : {}),
      seq: 1,
      kind,
      body: kind === "user" ? { queueState: "sent", sessionId: "session", ...body } : body,
      createdAt: at,
      updatedAt: at,
    },
  });
  return k;
}
const tool = (changes: Record<string, unknown>) => ({
  nativeItemId: "n",
  name: "Read",
  kind: "read",
  input: {},
  status: "ok",
  ...changes,
});

describe("session taint (12 section 6.3)", () => {
  it.each([
    ["fetch result", "tool", tool({ name: "WebFetch", kind: "fetch" }), "fetch"],
    [
      "browser evidence",
      "tool",
      tool({ name: "mcp__zoltbot__team_browser_evidence", kind: "other" }),
      "browser",
    ],
    [
      "connected app (prefixed)",
      "tool",
      tool({ name: "mcp__linear__get_issue", kind: "other" }),
      "connected_app",
    ],
    [
      "connected app (dotted)",
      "tool",
      tool({ name: "linear.get_issue", kind: "other" }),
      "connected_app",
    ],
    ["unknown tool", "tool", tool({ name: "Mystery", kind: "other" }), "unknown"],
    [
      "read outside workspace",
      "tool",
      tool({ locations: [{ path: "/etc/hosts" }] }),
      "outside_workspace",
    ],
    ["image attachment", "user", { input: [{ type: "image", path: "/tmp/x.png" }] }, "attachment"],
    [
      "peer message from unknown project",
      "user",
      { input: [{ type: "text", text: "hi" }], origin: "agent", sourceMessageId: "m1" },
      "cross_project_message",
    ],
  ] as const)("taints on %s", async (_name, kind, body, cause) => {
    const k = await withItem(kind, body);
    try {
      expect(refreshTaint(k.f.store, "session")).toMatchObject({ cause });
      // A tainted session's project write becomes a proposal; its own node still applies.
      expect((await k.write(lesson)).result).toBe("proposed");
      expect(
        (await k.write({ ...lesson, scope: "here", title: "Own", body: "Own node note." })).result,
      ).toBe("applied");
    } finally {
      k.f.close();
    }
  });
  it.each([
    ["zoltbot host tool", tool({ name: "mcp__zoltbot__team_get_knowledge", kind: "other" })],
    ["read inside workspace", tool({ locations: [{ path: "src/index.ts" }] })],
    ["denied fetch", tool({ name: "WebFetch", kind: "fetch", status: "denied" })],
    ["running fetch", tool({ name: "WebFetch", kind: "fetch", status: "running" })],
    ["shell command", tool({ name: "Bash", kind: "execute" })],
    [
      "local shell command",
      tool({ name: "Bash", kind: "execute", input: { command: "pnpm test" } }),
    ],
    ["local search", tool({ name: "Grep", kind: "search", input: { pattern: "fetch" } })],
  ])("does not taint on %s", async (_name, body) => {
    const k = await withItem("tool", body);
    try {
      expect(refreshTaint(k.f.store, "session")).toBeUndefined();
      expect((await k.write(lesson)).result).toBe("applied");
    } finally {
      k.f.close();
    }
  });
  it("treats a read inside the session cwd as trusted", async () => {
    const k = await knowledgeWriteFixture();
    try {
      const cwd = String(k.f.store.record("session", "session")?.cwd);
      k.change({
        type: "create",
        kind: "item",
        value: {
          id: "inside",
          threadId: "thread",
          turnId: "turn",
          seq: 1,
          kind: "tool",
          body: tool({ locations: [{ path: path.join(cwd, "a.ts") }] }),
          createdAt: at,
          updatedAt: at,
        },
      });
      expect(refreshTaint(k.f.store, "session")).toBeUndefined();
    } finally {
      k.f.close();
    }
  });
  it("persists the first cause, never clears it and is observed from published events", async () => {
    const k = await knowledgeWriteFixture();
    try {
      const observe = taintObserver(k.f.store);
      const before = k.f.store.lastSeq();
      k.change({
        type: "create",
        kind: "item",
        value: {
          id: "fetch",
          threadId: "thread",
          turnId: "turn",
          seq: 1,
          kind: "tool",
          body: tool({ name: "WebFetch", kind: "fetch" }),
          createdAt: at,
          updatedAt: at,
        },
      });
      observe(k.f.store.eventsSince(before));
      expect(readTaint(k.f.store, ["session"])).toMatchObject([
        { cause: "fetch", label: "WebFetch" },
      ]);
      expect(() =>
        k.f.store.database.prepare("DELETE FROM knowledge_session_taint").run(),
      ).toThrow();
      expect(refreshTaint(k.f.store, "session")).toMatchObject({ cause: "fetch" });
      const writes = (await k.tools.tools.get("team_write_knowledge")?.({
        actor: k.actor,
        arguments: lesson,
        idempotencyKey: "after",
      })) as { result: string };
      expect(writes.result).toBe("proposed");
    } finally {
      k.f.close();
    }
  });
  it("reports a run's writes and taint for the inspector", async () => {
    const k = await withItem("tool", tool({ name: "WebFetch", kind: "fetch" }));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime("2026-11-06T12:00:00.000Z");
      await k.write(lesson);
      vi.setSystemTime("2026-11-06T12:00:00.001Z");
      await k.write({ ...lesson, scope: "here", title: "Own", body: "Own node note." });
      const api = knowledgeReviewApi({
        store: k.f.store,
        publish() {},
        checkPublic: async () => () => {},
      });
      const result = (await api("knowledge.writes", { taskId: "t" })) as {
        writes: { outcome: string; reason: string; scope: unknown }[];
        taint: unknown[];
      };
      expect(result.writes.map((row) => [row.outcome, row.reason])).toEqual([
        ["proposed", "tainted"],
        ["applied", "own_node"],
      ]);
      expect(result.writes[1]?.scope).toEqual({ type: "task", id: "t" });
      expect(result.taint).toMatchObject([{ sessionId: "session", cause: "fetch" }]);
      await expect(api("knowledge.writes", { taskId: "missing" })).rejects.toThrow(
        "task_not_found",
      );
    } finally {
      vi.useRealTimers();
      k.f.close();
    }
  });
});
