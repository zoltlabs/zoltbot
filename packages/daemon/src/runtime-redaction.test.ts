import { AgentEventSchema, parse } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { Redactor } from "./logging.js";
import { redactRuntimeEvent } from "./runtime-redaction.js";

const redactor = new Redactor(["synthetic-private-value", "1"]);
it("redacts visible text and tool values while preserving structural identities and line numbers", () => {
  const event = redactRuntimeEvent(
    {
      t: "tool.started",
      turnId: "turn-1",
      itemId: "1",
      name: "read",
      kind: "read",
      input: { value: "synthetic-private-value", count: 1, api_key: "unregistered-private-field" },
      locations: [{ path: "synthetic-private-value.txt", line: 1 }],
    },
    redactor,
  );
  expect(event).toMatchObject({
    turnId: "turn-1",
    itemId: "1",
    kind: "read",
    input: { value: "[redacted]", count: "[redacted]", api_key: "[redacted]" },
    locations: [{ path: "[redacted].txt", line: 1 }],
  });
  expect(() => parse(AgentEventSchema, event)).not.toThrow();
  expect(
    redactRuntimeEvent(
      { t: "text.delta", turnId: "turn-1", itemId: "1", text: "synthetic-private-value" },
      redactor,
    ),
  ).toMatchObject({ text: "[redacted]", itemId: "1" });
});
it("keeps question choice ids valid while redacting prompts, labels, and context", () => {
  const event = redactRuntimeEvent(
    {
      t: "interaction.requested",
      interaction: {
        id: "1",
        nativeRef: "1",
        agentId: "profile-1",
        threadId: "thread-1",
        turnId: "turn-1",
        type: "question",
        chain: [],
        urgency: "blocking",
        items: [
          {
            id: "1",
            prompt: "synthetic-private-value",
            options: [{ id: "1", label: "synthetic-private-value" }],
          },
        ],
        context: { toolInput: { password: "unregistered" }, command: "synthetic-private-value" },
      },
    },
    redactor,
  );
  expect(event).toMatchObject({
    interaction: {
      id: "1",
      nativeRef: "1",
      threadId: "thread-1",
      items: [{ id: "1", prompt: "[redacted]", options: [{ id: "1", label: "[redacted]" }] }],
      context: { toolInput: { password: "[redacted]" }, command: "[redacted]" },
    },
  });
  expect(() => parse(AgentEventSchema, event)).not.toThrow();
});
it("retains usage counters and normalizes private diff and error content without altering codes", () => {
  const usage = {
    t: "usage.updated" as const,
    turnId: "turn-1",
    usage: { inputTokens: 1, costUsd: 1, cumulative: true },
  };
  expect(redactRuntimeEvent(usage, redactor)).toEqual(usage);
  expect(
    redactRuntimeEvent(
      {
        t: "tool.done",
        itemId: "1",
        status: "ok",
        output: { token: "private" },
        diffs: [{ path: "file", before: "synthetic-private-value", after: "safe" }],
      },
      redactor,
    ),
  ).toMatchObject({
    itemId: "1",
    output: { token: "[redacted]" },
    diffs: [{ before: "[redacted]", after: "safe" }],
  });
  expect(
    redactRuntimeEvent(
      {
        t: "turn.done",
        turnId: "turn-1",
        status: "failed",
        error: { code: "provider-1", message: "synthetic-private-value" },
      },
      redactor,
    ),
  ).toMatchObject({ turnId: "turn-1", error: { code: "provider-1", message: "[redacted]" } });
});
it("preserves form field metadata and drops reusable rules whose matcher contains private content", () => {
  const form = redactRuntimeEvent(
    {
      t: "interaction.requested",
      interaction: {
        id: "form",
        agentId: "profile",
        threadId: "thread",
        type: "form",
        chain: [],
        urgency: "blocking",
        items: [
          {
            id: "field",
            prompt: "Enter password",
            secret: true,
            schema: {
              type: "object",
              properties: { password: { type: "string", description: "synthetic-private-value" } },
              required: ["password"],
            },
          },
        ],
      },
    },
    redactor,
  );
  expect(form).toMatchObject({
    interaction: {
      items: [
        {
          schema: {
            properties: { password: { type: "string", description: "[redacted]" } },
            required: ["password"],
          },
        },
      ],
    },
  });
  const approval = redactRuntimeEvent(
    {
      t: "interaction.requested",
      interaction: {
        id: "approval",
        agentId: "profile",
        threadId: "thread",
        type: "approval",
        chain: [],
        urgency: "blocking",
        items: [
          {
            id: "a",
            prompt: "Allow?",
            default: "synthetic-private-value",
            choices: [
              { id: "allow_once" },
              {
                id: "allow_rule",
                rule: {
                  scope: "global",
                  decision: "allow",
                  matcher: {
                    tool: "execute",
                    command: { prefix: ["echo", "synthetic-private-value"] },
                  },
                },
              },
            ],
          },
        ],
      },
    },
    redactor,
  );
  expect(approval).toMatchObject({
    interaction: { items: [{ default: "[redacted]", choices: [{ id: "allow_once" }] }] },
  });
});
it("omits tool payloads in private sessions even when private values cross progress fields", () => {
  const redactor = new Redactor(["synthetic-private-tool-value"]);
  redactor.hideFrames();
  const events = [
    {
      t: "tool.started",
      turnId: "turn",
      itemId: "tool",
      name: "Shell",
      kind: "execute",
      input: { parts: ["synthetic-private-", "tool-value"] },
      locations: [{ path: "private-path", line: 1 }],
    },
    {
      t: "tool.updated",
      itemId: "tool",
      output: "synthetic-private-",
      content: [{ type: "text", text: "tool-value" }],
    },
    {
      t: "tool.done",
      itemId: "tool",
      status: "ok",
      output: ["synthetic-private-", "tool-value"],
      diffs: [{ path: "file", patch: "synthetic-private-" }],
    },
  ] as const;
  const projected = events.map((event) =>
    redactRuntimeEvent(parse(AgentEventSchema, event), redactor),
  );
  const text = JSON.stringify(projected);
  expect(text).not.toContain("synthetic-private-");
  expect(text).not.toContain("tool-value");
  expect(text).not.toContain("private-path");
  expect(projected[0]).toMatchObject({
    itemId: "tool",
    turnId: "turn",
    name: "Shell",
    kind: "execute",
  });
  expect(projected[2]).toMatchObject({ itemId: "tool", status: "ok" });
  expect(text).toContain("omitted");
});
it("redacts native command descriptions and omits private command names without breaking their schema", () => {
  const event = redactRuntimeEvent(
    {
      t: "session.ready",
      nativeId: "native",
      providerVersion: "fixture",
      capabilities: {
        resume: false,
        fork: false,
        steer: "queue_only",
        concurrentTurns: false,
        interrupt: "native",
        modes: [],
        models: { selectable: false },
        effort: [],
        approvals: "none",
        questions: "none",
        planReview: "none",
        elicitation: "none",
        usage: { tokens: false, cost: false, context: false, cache: false },
        compaction: { auto: false, manual: false, events: false },
        hostTools: "none",
        images: false,
        nativeSessions: { list: false, adopt: false, visibleInOfficialApps: "unknown" },
        worktreeAware: false,
        slashCommands: [
          { name: "synthetic-private-value" },
          {
            name: "public",
            description: "1".repeat(2000),
            argumentHint: "synthetic-private-value",
          },
        ],
      },
    },
    redactor,
  );
  expect(event.t).toBe("session.ready");
  if (event.t !== "session.ready") throw new Error("fixture_ready_missing");
  expect(event.capabilities.slashCommands).toHaveLength(1);
  expect(event.capabilities.slashCommands?.[0]).toMatchObject({
    name: "public",
    argumentHint: "[redacted]",
  });
  expect(event.capabilities.slashCommands?.[0]?.description).toHaveLength(2000);
  expect(JSON.stringify(event.capabilities.slashCommands)).not.toContain("synthetic-private-value");
  expect(() => parse(AgentEventSchema, event)).not.toThrow();
});
it("redacts tool titles, background tasks, choice labels and unsafe rule suggestions", () => {
  const scoped = new Redactor(["synthetic-private-value"]);
  expect(
    redactRuntimeEvent(
      {
        t: "tool.started",
        turnId: "turn",
        itemId: "tool",
        name: "Bash",
        kind: "execute",
        input: {},
        title: "curl synthetic-private-value",
        interactive: false,
      },
      scoped,
    ),
  ).toMatchObject({ title: "curl [redacted]", interactive: false });
  expect(
    redactRuntimeEvent(
      {
        t: "background.updated",
        task: {
          id: "bg",
          kind: "shell",
          description: "serve synthetic-private-value",
          state: "running",
          summary: "synthetic-private-value ready",
          outputPath: "/tmp/synthetic-private-value.log",
        },
      },
      scoped,
    ),
  ).toMatchObject({
    task: {
      id: "bg",
      description: "serve [redacted]",
      summary: "[redacted] ready",
      outputPath: "/tmp/[redacted].log",
    },
  });
  const request = (matcher: { tool: string; command: { prefix: string[] } }) =>
    redactRuntimeEvent(
      {
        t: "interaction.requested",
        interaction: {
          id: "approval",
          agentId: "profile",
          threadId: "thread",
          type: "approval",
          urgency: "blocking",
          chain: [],
          context: { toolName: "Bash", ruleSuggestion: matcher },
          items: [
            {
              id: "a",
              prompt: "Allow?",
              choices: [{ id: "allow_once", label: "Bash(synthetic-private-value)" }],
            },
          ],
        },
      },
      scoped,
    );
  const safe = request({ tool: "Bash", command: { prefix: ["npm", "test"] } });
  expect(safe).toMatchObject({
    interaction: {
      context: { ruleSuggestion: { tool: "Bash", command: { prefix: ["npm", "test"] } } },
      items: [{ choices: [{ id: "allow_once", label: "Bash([redacted])" }] }],
    },
  });
  const unsafe = request({ tool: "Bash", command: { prefix: ["synthetic-private-value"] } });
  expect(unsafe.t === "interaction.requested" && unsafe.interaction.context).not.toHaveProperty(
    "ruleSuggestion",
  );
  scoped.hideFrames();
  const hidden = redactRuntimeEvent(
    {
      t: "background.updated",
      task: { id: "bg", kind: "shell", description: "anything", state: "running", summary: "x" },
    },
    scoped,
  );
  expect(hidden).toEqual({
    t: "background.updated",
    task: { id: "bg", kind: "shell", description: "[private background task]", state: "running" },
  });
  expect(
    redactRuntimeEvent(
      {
        t: "tool.started",
        turnId: "t",
        itemId: "i",
        name: "Bash",
        kind: "execute",
        input: {},
        title: "ls",
      },
      scoped,
    ),
  ).not.toHaveProperty("title");
});

it("retains a derived test category while hiding command text and output", () => {
  const privateRedactor = new Redactor();
  privateRedactor.hideFrames();
  const start = redactRuntimeEvent(
    {
      t: "tool.started",
      turnId: "turn",
      itemId: "check",
      name: "Shell",
      kind: "execute",
      input: { command: "node --test --test-name-pattern=confidential" },
    },
    privateRedactor,
  );
  expect(start).toMatchObject({ check: "tests", input: "[private tool input omitted]" });
  expect(JSON.stringify(start)).not.toContain("confidential");
  const spoof = redactRuntimeEvent(
    {
      t: "tool.started",
      turnId: "turn",
      itemId: "not-check",
      name: "Shell",
      kind: "execute",
      check: "tests",
      input: { command: "echo tests passed" },
    },
    privateRedactor,
  );
  expect(spoof).not.toHaveProperty("check");
});
