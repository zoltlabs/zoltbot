import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { type ClaudePolicy, claudeAnswer, claudeInteraction, grantedMode } from "./interactions.js";

const ids = { id: "request", agentId: "profile", threadId: "thread", turnId: "turn" };
const owner = { kind: "human" as const, id: "owner" };
const at = "2026-11-05T00:00:00Z";
const write: ClaudePolicy = {
  modes: ["default", "acceptEdits", "plan"],
  baseMode: "default",
  cwd: "/work",
};
const readOnly: ClaudePolicy = { modes: ["default", "plan"], baseMode: "default", cwd: "/work" };
const valid = (draft: ReturnType<typeof claudeInteraction>) =>
  parse(AgentEventSchema, { t: "interaction.requested", interaction: draft });
const choices = (draft: ReturnType<typeof claudeInteraction>) => draft.items[0]?.choices;

it("shows edit approvals with the proposed change", () => {
  const multi = claudeInteraction(
    {
      subtype: "can_use_tool",
      tool_name: "MultiEdit",
      input: {
        file_path: "/work/a.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      },
    },
    ids,
    undefined,
    write,
  );
  expect(multi.context).toMatchObject({
    toolKind: "edit",
    paths: ["/work/a.ts"],
    diffs: [
      { path: "/work/a.ts", before: "a", after: "b" },
      { path: "/work/a.ts", before: "c", after: "d" },
    ],
    ruleSuggestion: { tool: "MultiEdit", kind: "edit", paths: ["a.ts"] },
  });
  const created = claudeInteraction(
    {
      subtype: "can_use_tool",
      tool_name: "Write",
      input: { file_path: "/elsewhere/b.ts", content: "new" },
    },
    ids,
    undefined,
    write,
  );
  expect(created.context?.diffs).toEqual([{ path: "/elsewhere/b.ts", after: "new" }]);
  // Outside the workspace there is no path rule to suggest.
  expect(created.context?.ruleSuggestion).toBeUndefined();
  valid(multi);
  valid(created);
});

it("offers native session grants with a label and forwards them only to the session", () => {
  const request = {
    subtype: "can_use_tool",
    tool_name: "Bash",
    tool_use_id: "tool",
    input: { command: "npm test --watch" },
    permission_suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "localSettings",
        extra: "ignored",
      },
      { type: "addDirectories", directories: ["/"], destination: "session" },
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny", destination: "session" },
      { type: "setMode", mode: "bypassPermissions", destination: "userSettings" },
    ],
  };
  const draft = claudeInteraction(request, ids, undefined, write);
  expect(choices(draft)).toEqual([
    { id: "allow_once" },
    { id: "allow_session", label: "Bash(npm test:*)" },
    { id: "reject_once" },
  ]);
  expect(draft.context).toMatchObject({
    toolKind: "execute",
    command: "npm test --watch",
    ruleSuggestion: { tool: "Bash", kind: "execute", command: { prefix: ["npm", "test"] } },
  });
  valid(draft);
  expect(
    claudeAnswer(request, { action: "accept", choice: "allow_session", by: owner, at }, write),
  ).toEqual({
    behavior: "allow",
    updatedInput: request.input,
    updatedPermissions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "session",
      },
    ],
  });
  // Without usable suggestions the session choice is neither offered nor honored.
  const bare = { ...request, permission_suggestions: [request.permission_suggestions[1]] };
  expect(choices(claudeInteraction(bare, ids, undefined, write))).toEqual([
    { id: "allow_once" },
    { id: "reject_once" },
  ]);
  expect(
    claudeAnswer(bare, { action: "accept", choice: "allow_session", by: owner, at }, write),
  ).toMatchObject({ behavior: "deny" });
});

it("labels a session mode grant and reports the granted mode", () => {
  const request = {
    subtype: "can_use_tool",
    tool_name: "Edit",
    input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" },
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  };
  expect(choices(claudeInteraction(request, ids, undefined, write))?.[1]).toEqual({
    id: "allow_session",
    label: "mode acceptEdits",
  });
  const reply = claudeAnswer(
    request,
    { action: "accept", choice: "allow_session", by: owner, at },
    write,
  );
  expect(grantedMode(reply)).toBe("acceptEdits");
  // Read only profiles cannot be widened through a suggestion.
  expect(choices(claudeInteraction(request, ids, undefined, readOnly))).toHaveLength(2);
});

it.each([
  ["broad prefix", "npm run build", "npm:*"],
  ["wildcard", "npm run build", "npm run *:*"],
  ["other command", "npm run build", "npm test:*"],
  ["shell operators", "npm test && rm x", "npm test:*"],
  // Exact native rules name one command; an argv prefix would also allow longer ones.
  ["exact rule", "rm -rf build", "rm -rf build"],
])("suggests no command rule for a %s", (_label, command, ruleContent) => {
  const draft = claudeInteraction(
    {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command },
      permission_suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent }], behavior: "allow" },
      ],
    },
    ids,
    undefined,
    write,
  );
  expect(draft.context?.ruleSuggestion).toBeUndefined();
});

it("forwards only acceptEdits mode grants and never offers a grant it cannot fully label", () => {
  const ask = (permission_suggestions: unknown[]) => {
    const request = {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: { command: "npm test" },
      permission_suggestions,
    };
    return {
      choices: choices(claudeInteraction(request, ids, undefined, write)),
      reply: claudeAnswer(
        request,
        { action: "accept", choice: "allow_session", by: owner, at },
        write,
      ),
    };
  };
  // default is in the profile's modes but is not a grant to forward.
  const mode = ask([{ type: "setMode", mode: "default", destination: "session" }]);
  expect(mode.choices?.map((c) => c.id)).toEqual(["allow_once", "reject_once"]);
  expect(mode.reply).toMatchObject({ behavior: "deny" });
  const long = ask([
    {
      type: "addRules",
      rules: Array.from({ length: 12 }, (_, i) => ({
        toolName: "Bash",
        ruleContent: `npm run task-${i}:*`,
      })),
      behavior: "allow",
    },
  ]);
  expect(long.choices?.map((c) => c.id)).toEqual(["allow_once", "reject_once"]);
  expect(long.reply).toMatchObject({ behavior: "deny" });
});

it("sends secret question values to Claude", () => {
  const request = {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    input: { questions: [{ question: "Token?", options: [], secret: true }] },
  };
  expect(claudeInteraction(request, ids).items[0]?.secret).toBe(true);
  expect(
    claudeAnswer(request, {
      action: "accept",
      answers: { q1: { value: "s3cret" } },
      by: owner,
      at,
    }),
  ).toMatchObject({ updatedInput: { answers: { "Token?": "s3cret" } } });
  expect(() =>
    claudeAnswer(request, { action: "accept", answers: { q1: { value: 4 } }, by: owner, at }),
  ).toThrow("invalid_question_answer");
});

it("suggests exact host and MCP tool rules", () => {
  const fetch = claudeInteraction(
    {
      subtype: "can_use_tool",
      tool_name: "WebFetch",
      input: { url: "https://Docs.Example.com/a" },
    },
    ids,
    undefined,
    write,
  );
  expect(fetch.context).toMatchObject({
    toolKind: "fetch",
    network: { host: "docs.example.com", protocol: "https" },
    ruleSuggestion: { tool: "WebFetch", kind: "fetch", host: "docs.example.com" },
  });
  const mcp = claudeInteraction(
    { subtype: "can_use_tool", tool_name: "mcp__linear__create_issue", input: {} },
    ids,
    undefined,
    write,
  );
  expect(mcp.context).toMatchObject({
    toolKind: "other",
    ruleSuggestion: { tool: "mcp__linear__create_issue", kind: "other" },
  });
  const local = claudeInteraction(
    { subtype: "can_use_tool", tool_name: "WebFetch", input: { url: "http://localhost:3000" } },
    ids,
    undefined,
    write,
  );
  expect(local.context?.ruleSuggestion).toBeUndefined();
  for (const draft of [fetch, mcp, local]) valid(draft);
});

it("reviews plans with optional auto accepted edits and native mode updates", () => {
  const request = { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "# P" } };
  expect(choices(claudeInteraction(request, ids, undefined, write))).toEqual([
    { id: "allow_accept_edits" },
    { id: "allow_once" },
    { id: "reject_once" },
  ]);
  expect(choices(claudeInteraction(request, ids, undefined, readOnly))).toEqual([
    { id: "allow_once" },
    { id: "reject_once" },
  ]);
  const edits = claudeAnswer(
    request,
    { action: "accept", choice: "allow_accept_edits", by: owner, at },
    write,
  );
  expect(edits).toEqual({
    behavior: "allow",
    updatedInput: { plan: "# P" },
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
  expect(grantedMode(edits)).toBe("acceptEdits");
  expect(
    claudeAnswer(
      request,
      { action: "accept", choice: "allow_once", feedback: "Add tests.", by: owner, at },
      write,
    ),
  ).toEqual({
    behavior: "allow",
    updatedInput: { plan: "# P\n\n## Reviewer notes\nAdd tests." },
    updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
  });
  expect(
    claudeAnswer(
      request,
      { action: "accept", choice: "allow_accept_edits", by: owner, at },
      readOnly,
    ),
  ).toMatchObject({ behavior: "deny" });
  expect(
    claudeAnswer(request, { action: "decline", feedback: "Smaller steps.", by: owner, at }, write),
  ).toEqual({ behavior: "deny", message: "Smaller steps." });
  // A stripped request takes the plan the session reviewed.
  const stripped = { ...request, input: {} };
  expect(
    claudeAnswer(
      stripped,
      { action: "accept", choice: "allow_once", feedback: "Go.", by: owner, at },
      write,
      "# From file",
    ),
  ).toMatchObject({ updatedInput: { plan: "# From file\n\n## Reviewer notes\nGo." } });
});

it("maps flat elicitation forms and validates answers", () => {
  const request = {
    subtype: "elicitation",
    mcp_server_name: "fixture",
    message: "Pick a name",
    mode: "form",
    requested_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  };
  const draft = claudeInteraction(request, ids);
  expect(draft).toMatchObject({
    type: "form",
    title: "fixture: Pick a name",
    items: [{ id: "form", prompt: "Pick a name", schema: request.requested_schema }],
  });
  valid(draft);
  expect(
    claudeAnswer(request, {
      action: "accept",
      answers: { form: { value: { name: "Ada" } } },
      by: owner,
      at,
    }),
  ).toEqual({ action: "accept", content: { name: "Ada" } });
  expect(() =>
    claudeAnswer(request, { action: "accept", answers: { form: { value: {} } }, by: owner, at }),
  ).toThrow("invalid_form_answer");
  expect(claudeAnswer(request, { action: "decline", by: owner, at })).toEqual({
    action: "decline",
  });
  expect(claudeAnswer(request, { action: "timeout", by: owner, at })).toEqual({ action: "cancel" });
});

it("asks consent for URL elicitations and refuses unsupported schemas", () => {
  const url = {
    subtype: "elicitation",
    message: "Sign in",
    mode: "url",
    url: "https://example.com/authorize",
  };
  const draft = claudeInteraction(url, ids);
  expect(draft).toMatchObject({
    type: "form",
    context: { markdown: expect.stringContaining("https://example.com/authorize") },
    items: [{ id: "form", schema: { type: "object", properties: {} } }],
  });
  valid(draft);
  expect(claudeAnswer(url, { action: "accept", by: owner, at })).toEqual({ action: "accept" });
  for (const request of [
    { ...url, url: "javascript:alert(1)" },
    { subtype: "elicitation", message: "x", mode: "other" },
    {
      subtype: "elicitation",
      message: "x",
      requested_schema: { type: "object", properties: { a: { type: "object" } } },
    },
    { subtype: "elicitation", message: "x", requested_schema: { type: "string" } },
  ])
    expect(() => claudeInteraction(request, ids)).toThrow();
});
