import "../packages/ui/src/shell/shell.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import Chat from "../packages/ui/src/chat/Chat.js";
import type { ChatConnection, Row } from "../packages/ui/src/chat/types.js";

/** Normalized desktop parity data, shaped like the daemon's snapshot. No provider tool names drive rendering. */
const at = "2026-11-05T12:00:00Z";
let seq = 0;
const item = (id: string, kind: string, body: Row, turnId = "turn-1"): Row => ({
  id,
  threadId: "h",
  turnId,
  seq: ++seq,
  kind,
  body,
  createdAt: at,
  updatedAt: at,
});
const png =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKElEQVR42mNkYPj/n4EBDzA0NGBkZMRrAAONGRkZ+RlwGkFNAwYGBgYAkVIJE4kgiGkAAAAASUVORK5CYII=";
function items(): Row[] {
  seq = 0;
  return [
    item("u1", "user", {
      input: [{ type: "text", text: "Fix the failing greeting test" }],
      queueState: "sent",
    }),
    item("p1", "plan", {
      entries: [
        { step: "Run the test suite", status: "in_progress" },
        { step: "Fix the greeting", status: "pending" },
        { step: "Check the result", status: "pending" },
      ],
    }),
    item("t-exec", "tool", {
      nativeItemId: "n-exec",
      name: "Shell",
      kind: "execute",
      title: "npm test -- greeting",
      status: "error",
      input: { command: "npm test -- greeting" },
      output: `\u001b[31mFAIL\u001b[0m src/greeting.test.ts\n${Array.from({ length: 30 }, (_, i) => `  line ${i + 1} of output`).join("\n")}\nTests: 1 failed, 4 passed`,
    }),
    item("t-read", "tool", {
      nativeItemId: "n-read",
      name: "Reader",
      kind: "read",
      title: "src/greeting.ts",
      status: "ok",
      locations: [{ path: "src/greeting.ts", line: 1 }],
      output: "export const greeting = 'old';\n",
    }),
    item("t-search", "tool", {
      nativeItemId: "n-search",
      name: "Finder",
      kind: "search",
      title: "greeting",
      status: "ok",
      output: "src/greeting.ts:1\nsrc/greeting.test.ts:3\nsrc/index.ts:8",
    }),
    item("p2", "plan", {
      entries: [
        { step: "Run the test suite", status: "completed" },
        { step: "Fix the greeting", status: "in_progress" },
        { step: "Check the result", status: "pending" },
      ],
    }),
    item("t-edit", "tool", {
      nativeItemId: "n-edit",
      name: "Editor",
      kind: "edit",
      title: "src/greeting.ts",
      status: "ok",
      locations: [{ path: "src/greeting.ts" }],
      diffs: [
        {
          path: "src/greeting.ts",
          before: "// Greeting\nexport const greeting = 'old';\nexport const name = 'world';\n",
          after:
            "// Greeting\nexport const greeting = 'hello';\nexport const name = 'world';\nexport const both = greeting + name;\n",
        },
      ],
    }),
    item("t-fetch", "tool", {
      nativeItemId: "n-fetch",
      name: "Web",
      kind: "fetch",
      title: "https://example.com/docs/greeting",
      status: "ok",
      output: "Greeting docs. See https://example.com/docs/more for details.",
    }),
    item("t-agent", "tool", {
      nativeItemId: "n-agent",
      name: "Delegate",
      kind: "agent",
      title: "Review the test coverage",
      status: "running",
    }),
    item("a-read", "tool", {
      nativeItemId: "n-a-read",
      name: "Reader",
      kind: "read",
      title: "src/greeting.test.ts",
      status: "ok",
      parentItemId: "n-agent",
      locations: [{ path: "src/greeting.test.ts" }],
      output: "it('greets', () => {});",
    }),
    item("a-shot", "tool", {
      nativeItemId: "n-a-shot",
      name: "Screenshot",
      kind: "other",
      title: "Capture the page",
      status: "ok",
      parentItemId: "n-agent",
      content: [{ type: "image", mimeType: "image/png", data: png }],
    }),
    item("a-msg", "message", {
      text: "Coverage looks complete for the greeting module.",
      parentItemId: "n-agent",
    }),
    item("t-ask", "tool", {
      nativeItemId: "n-ask",
      name: "Ask",
      kind: "other",
      title: "Which greeting?",
      status: "ok",
      interactive: true,
    }),
    item("m1", "message", { text: "The greeting is fixed and the tests pass." }, "turn-1"),
    item(
      "u2",
      "user",
      { input: [{ type: "text", text: "Now update the docs" }], queueState: "sent" },
      "turn-2",
    ),
  ];
}
function interaction(kind: string): Row | undefined {
  const base = {
    agentId: "p",
    threadId: "h",
    chain: [],
    urgency: "blocking",
    version: 1,
    state: "pending",
    createdAt: at,
  };
  if (kind === "approval")
    return {
      ...base,
      id: "req-approval",
      type: "approval",
      title: "Edit src/greeting.ts",
      context: {
        toolKind: "edit",
        diffs: [
          {
            path: "src/greeting.ts",
            patch:
              "@@ -1,2 +1,2 @@\n // Greeting\n-export const greeting = 'old';\n+export const greeting = 'hello';",
          },
        ],
        ruleSuggestion: { tool: "Edit", kind: "edit", paths: ["src/**"] },
      },
      items: [
        {
          id: "a",
          prompt: "Allow this edit?",
          choices: [
            { id: "allow_once" },
            { id: "allow_session", label: "Edit(src/**)" },
            { id: "reject_once" },
          ],
        },
      ],
    };
  if (kind === "plan")
    return {
      ...base,
      id: "req-plan",
      type: "plan",
      title: "Review the plan",
      context: {
        markdown: "# Plan\n\n1. Update the README\n2. Add an example\n3. Run the docs check",
      },
      items: [
        {
          id: "a",
          prompt: "Approve this plan?",
          choices: [{ id: "allow_accept_edits" }, { id: "allow_once" }, { id: "reject_once" }],
        },
      ],
    };
  if (kind === "form")
    return {
      ...base,
      id: "req-form",
      type: "form",
      title: "Sign in to the docs server",
      context: { markdown: "Authorize access at https://auth.example.com/device?code=ABCD." },
      items: [
        {
          id: "form",
          prompt: "Open the link to authorize.",
          schema: { type: "object", properties: {} },
        },
      ],
    };
  return undefined;
}
export function mountChatParity(theme: string, pending = "", mode = "default") {
  document.documentElement.dataset.theme = theme;
  const root = document.createElement("main");
  root.id = "parity-root";
  root.className = "zb";
  root.style.height = "100vh";
  root.style.display = "flex";
  document.body.replaceChildren(root);
  const calls: { method: string; params: unknown }[] = [];
  (window as unknown as { parityCalls: typeof calls }).parityCalls = calls;
  const request = interaction(pending);
  const connection: ChatConnection = {
    status: "online",
    snapshot: {
      seq: 1,
      counters: {},
      entities: {
        agentDefinition: [{ id: "reference", displayName: "Reference coding tool" }],
        agent: [
          {
            id: "p",
            definitionId: "reference",
            name: "Builder",
            permissionProfile: "workspace_write",
          },
        ],
        project: [{ id: "proj", name: "Greeter" }],
        thread: [
          { id: "h", agentId: "p", projectId: "proj", title: "Parity review", createdAt: at },
        ],
        session: [
          {
            id: "s",
            threadId: "h",
            state: "ready",
            startedAt: at,
            mode,
            capabilities: {
              modes: ["default", "acceptEdits", "plan", "bypassPermissions"],
              safeModes: ["default", "acceptEdits", "plan"],
              rewind: true,
              backgroundTasks: true,
              compaction: { manual: true },
            },
            background: [
              {
                id: "bg1",
                kind: "shell",
                description: "npm run dev",
                state: "running",
                summary: "Listening on :5173",
              },
              {
                id: "bg2",
                kind: "agent",
                description: "Index the repository",
                state: "completed",
                summary: "142 files",
              },
            ],
          },
        ],
        turn: [
          { id: "turn-1", threadId: "h", sessionId: "s", status: "completed", startedAt: at },
          { id: "turn-2", threadId: "h", sessionId: "s", status: "completed", startedAt: at },
        ],
        item: items(),
        interaction: [
          ...(request ? [request] : []),
          { ...base(), id: "req-ask", nativeRef: "n-ask", type: "question", state: "answered" },
        ],
      },
    },
    async call(method, params) {
      calls.push({ method, params });
      if (method === "session.rewind")
        return {
          canRewind: true,
          files: ["src/greeting.ts", "README.md"],
          insertions: 4,
          deletions: 2,
        };
      if (method === "rule.create")
        return {
          ...(params as { rule: Row }).rule,
          id: "rule",
          createdBy: { kind: "human", id: "local-owner" },
          createdAt: at,
        };
      return { ok: true };
    },
  };
  function base() {
    return {
      agentId: "p",
      threadId: "h",
      chain: [],
      urgency: "blocking",
      version: 1,
      createdAt: at,
      items: [{ id: "q", prompt: "Which greeting?" }],
    };
  }
  createRoot(root).render(
    <QueryClientProvider client={new QueryClient()}>
      <Chat connection={connection} threadId="h" />
    </QueryClientProvider>,
  );
}
