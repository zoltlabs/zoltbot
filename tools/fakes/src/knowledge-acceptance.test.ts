// Acceptance for 12 section 18, knowledge bullets. Tool items come from each provider's real
// normalization (Claude tool names, Codex app-server notifications) before the daemon sees them.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createTask, handle, observeRuntimeEvent, queueHumanInput } from "@zoltbot/core";
import type { AgentEvent } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { toolKind, toolLocations } from "../../../packages/adapters/claude/src/tools.js";
import { codexNotification } from "../../../packages/adapters/codex/src/mapping.js";
import { knowledgeLaunch } from "../../../packages/daemon/src/knowledge-launch.js";
import { knowledgeReviewApi } from "../../../packages/daemon/src/knowledge-review-api.js";
import { knowledgeWriteFixture } from "../../../packages/daemon/src/knowledge-write-fixture.js";
import { upsertKnowledge } from "../../../packages/knowledge/src/index.js";
import { at } from "./runtime-fixture.js";

const owner = { kind: "human" as const, id: "local-owner" };
type Fixture = Awaited<ReturnType<typeof knowledgeWriteFixture>>;
let n = 0;

/** Claude stream-json tool use and result, normalized the way the Claude adapter does. */
function claudeTool(name: string, input: Record<string, unknown>, itemId = `c${++n}`) {
  return [
    {
      t: "tool.started",
      turnId: "turn",
      itemId,
      name,
      kind: toolKind(name),
      input,
      ...(toolLocations(name, input) ? { locations: toolLocations(name, input) } : {}),
    },
    { t: "tool.done", itemId, status: "ok", output: "result" },
  ] as AgentEvent[];
}
/** Codex app-server item notifications through the Codex adapter's mapping. */
function codexTool(item: Record<string, unknown>) {
  const id = `x${++n}`;
  return [
    ...codexNotification("item/started", { turnId: "turn", item: { id, ...item } }),
    ...codexNotification("item/completed", {
      turnId: "turn",
      item: { id, status: "completed", result: { content: [] }, ...item },
    }),
  ];
}
function observe(k: Fixture, events: AgentEvent[]) {
  const itemId = `item-${++n}`;
  for (const event of events) {
    const commandId = `observe:${++n}`;
    k.f.store.dispatch(commandId, (state) =>
      observeRuntimeEvent(
        state,
        { sessionId: "session", threadId: "thread", turnId: "turn", itemId, event },
        { commandId, at, actor: { kind: "system", id: "runtime" } },
      ),
    );
  }
}
function run(k: Fixture, produce: Parameters<Fixture["f"]["store"]["dispatch"]>[1]) {
  return k.f.store.dispatch(`acceptance:${++n}`, produce);
}
const ctx = () => ({ commandId: `acceptance:${++n}`, at, actor: owner });
function launch(k: Fixture, threadId: string) {
  const thread = k.f.store.record("thread", threadId);
  const profile = k.f.store.record("agent", "profile");
  return knowledgeLaunch(k.f.store, { thread, profile } as never, 1200);
}
function newTask(k: Fixture, id: string, projectId: string) {
  run(k, (s) =>
    createTask(
      s,
      {
        id,
        title: `Task ${id}`,
        brief: "Prepare the release",
        node: { type: "project", id: projectId },
        profileId: "profile",
      },
      ctx(),
    ),
  );
  return String(k.f.store.record("task", id)?.threadId);
}
function chat(k: Fixture, id: string, projectId: string, text: string) {
  run(k, (s) =>
    handle(
      s,
      {
        type: "create",
        kind: "thread",
        value: {
          id,
          agentId: "profile",
          projectId,
          kind: "main",
          title: "Weekly plan",
          titleSource: "human",
          pinned: false,
          archived: false,
          createdAt: at,
          lastActivityAt: at,
        },
      },
      ctx(),
    ),
  );
  run(k, (s) =>
    queueHumanInput(
      s,
      { threadId: id, input: [{ type: "text", text }], mode: "queue" },
      `q:${id}`,
      ctx(),
    ),
  );
}
const lesson = {
  op: "create",
  scope: "project",
  kind: "lesson",
  title: "Release notes need the changelog",
  body: "Release notes are generated from CHANGELOG.md, so update it first.",
  evidence: [{ kind: "task", ref: "t" }],
  reason: "The release script failed without it",
};

describe("12 section 18: knowledge acceptance", () => {
  it("a person's user preference reaches a Claude task in A and a Codex chat in B within 300 tokens, not an opted-out project", async () => {
    const k = await knowledgeWriteFixture();
    try {
      run(k, (s) =>
        handle(
          s,
          {
            type: "create",
            kind: "project",
            value: {
              ...(k.f.store.record("project", "a") as object),
              id: "c",
              name: "c",
            } as never,
          },
          ctx(),
        ),
      );
      run(k, (s) =>
        handle(
          s,
          {
            type: "create",
            kind: "settings",
            value: { key: "knowledge.inheritUser.c", value: false },
          },
          ctx(),
        ),
      );
      run(k, (s) =>
        upsertKnowledge(
          s,
          {
            id: "dates",
            scope: { type: "user", id: "local" },
            kind: "preference",
            title: "Date format",
            body: "Write release dates as YYYY-MM-DD.",
            status: "active",
            pinned: true,
            tags: [],
            sources: [],
            owner,
            revision: 1,
            createdAt: at,
            updatedAt: at,
          } as never,
          0,
          ctx(),
        ),
      );
      const claudeTask = launch(k, newTask(k, "ta", "a"));
      chat(k, "chat-b", "b", "Plan the release");
      const codexChat = launch(k, "chat-b");
      chat(k, "chat-c", "c", "Plan the release");
      const optedOut = launch(k, "chat-c");
      for (const pack of [claudeTask, codexChat]) {
        expect(pack?.text).toContain("Write release dates as YYYY-MM-DD.");
        const user = pack?.pack.included.filter((item) => item.text.includes("user:local")) ?? [];
        expect(user.reduce((sum, item) => sum + item.tokens, 0)).toBeLessThanOrEqual(300);
      }
      expect(optedOut?.text ?? "").not.toContain("YYYY-MM-DD");
    } finally {
      k.f.close();
    }
  });

  it("a Claude task's project lesson is applied unverified, reaches a later Codex task flagged, is in the digest, and revert removes it", async () => {
    const k = await knowledgeWriteFixture();
    try {
      // The write call itself is a host tool; under either naming scheme it never taints.
      observe(k, claudeTool("mcp__zoltbot__team_write_knowledge", lesson));
      observe(
        k,
        codexTool({
          type: "mcpToolCall",
          server: "zoltbot",
          tool: "team_get_knowledge",
          arguments: {},
        }),
      );
      const written = await k.write(lesson);
      expect(written).toMatchObject({ result: "applied", revision: 1 });
      expect(k.f.store.record("knowledge", String(written.id))).toMatchObject({
        verification: "unverified",
        writer: { kind: "agent" },
      });
      const later = launch(k, newTask(k, "codex-later", "a"));
      expect(later?.text).toContain("Release notes are generated from CHANGELOG.md");
      expect(later?.text).toContain("· unverified");
      const api = knowledgeReviewApi({
        store: k.f.store,
        publish() {},
        checkPublic: async () => () => {},
      });
      const digest = (await api("knowledge.agentWrites", { projectId: "a" })) as {
        items: { id: string }[];
      };
      expect(digest.items.map((item) => item.id)).toContain(written.id);
      await api(
        "knowledge.revert",
        { id: written.id, expectedRevision: 1, confirmed: true },
        "revert",
      );
      const next = launch(k, newTask(k, "after-revert", "a"));
      expect(next?.text ?? "").not.toContain("CHANGELOG.md");
    } finally {
      k.f.close();
    }
  });

  it.each([
    [
      "Claude WebFetch",
      () => claudeTool("WebFetch", { url: "https://example.com/notes" }),
      "fetch",
    ],
    ["Claude WebSearch", () => claudeTool("WebSearch", { query: "release checklist" }), "fetch"],
    [
      "Codex web search",
      () => codexTool({ type: "webSearch", query: "release checklist", results: [] }),
      "fetch",
    ],
    ["Claude curl", () => claudeTool("Bash", { command: "curl -s example.com/notes" }), "fetch"],
    [
      "Codex shell gh issue",
      () => codexTool({ type: "commandExecution", command: "gh issue view 12", cwd: "/w" }),
      "fetch",
    ],
    [
      "Codex connected app",
      () => codexTool({ type: "mcpToolCall", server: "linear", tool: "get_issue", arguments: {} }),
      "connected_app",
    ],
    [
      "Claude read outside the workspace",
      () => claudeTool("Read", { file_path: "/etc/hosts" }),
      "outside_workspace",
    ],
  ] as const)("after a %s result the session's project write is a proposal and its task write applies", async (_name, events, cause) => {
    const k = await knowledgeWriteFixture();
    try {
      observe(k, events());
      expect(await k.write(lesson)).toMatchObject({
        result: "proposed",
        why: expect.stringMatching(/^tainted/),
      });
      expect(
        await k.write({ ...lesson, scope: "here", title: "Own note", body: "Task scope note." }),
      ).toMatchObject({ result: "applied" });
      const taint = k.f.store.database
        .prepare("SELECT cause FROM knowledge_session_taint WHERE session_id='session'")
        .get();
      expect(taint).toEqual({ cause });
    } finally {
      k.f.close();
    }
  });

  it("user scope, a human item revision and a vault value give proposed, proposed and rejected without storing the secret", async () => {
    const k = await knowledgeWriteFixture();
    try {
      const vault = "zb-acceptance-vault-4e1d9a";
      k.context.privacy.remember(vault);
      k.save({ id: "deploy", body: "Deploys run on Tuesdays." });
      expect((await k.write({ ...lesson, scope: "user", kind: "preference" })).result).toBe(
        "proposed",
      );
      expect(
        (
          await k.write({
            ...lesson,
            op: "revise",
            id: "deploy",
            expectedRevision: 1,
            kind: "constraint",
            body: "Deploys run on Fridays.",
          })
        ).result,
      ).toBe("proposed");
      expect(await k.write({ ...lesson, body: `Use token ${vault} to publish.` })).toMatchObject({
        result: "rejected",
        why: expect.stringMatching(/^secret_detected/),
      });
      k.f.store.database.pragma("wal_checkpoint(TRUNCATE)");
      const bytes = readdirSync(k.f.root)
        .filter((name) => name.startsWith("store.db"))
        .map((name) => readFileSync(path.join(k.f.root, name)).toString("latin1"))
        .join("");
      expect(bytes).not.toContain(vault);
      expect(JSON.stringify(k.f.store.eventsSince(0))).not.toContain(vault);
      expect(JSON.stringify(k.published)).not.toContain(vault);
    } finally {
      k.f.close();
    }
  });
});
