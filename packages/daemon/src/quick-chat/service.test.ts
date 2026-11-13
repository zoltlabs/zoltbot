import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import path from "node:path";
import type {
  AgentDefinition,
  QuickConnection,
  QuickMessage,
  QuickRequest,
} from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { fakeToolDefinitions } from "../../../../tools/fakes/src/quick-chat-tools.js";
import { recommendedModel } from "./service.js";
import {
  apiKeyConnection,
  type Fixture,
  fixture,
  responsesCalls,
  settled,
} from "./service-test-fixture.js";

it("creates a general chat on first send, streams with attribution, and never stores the key", async () => {
  const test = await fixture();
  expect(await test.call("quickConnection.list")).toMatchObject({
    items: [],
    settings: { deeperModels: {} },
  });
  await expect(
    test.call("quickChat.send", { text: "Hi", connectionId: "none", model: "x" }, "c0"),
  ).rejects.toThrow("quick_connection_unavailable");
  expect((await test.call("quickChat.list")).items).toEqual([]);

  const connection = await apiKeyConnection(test);
  expect(connection).toMatchObject({
    kind: "api_key",
    billing: "user_api_key",
    status: "ready",
    hasSecret: true,
    host: { name: "Test Mac" },
  });
  expect(connection.models.map((model) => model.id)).toContain("fake-fast");
  expect(
    recommendedModel([
      { id: "big-model", label: "Big", source: "discovered" },
      { id: "fast-mini", label: "Mini", source: "discovered" },
    ]),
  ).toBe("fast-mini");
  await expect(
    test.call(
      "quickChat.send",
      { text: "Hi", connectionId: connection.id, model: "gpt-unlisted" },
      "c1",
    ),
  ).rejects.toThrow("quick_model_unavailable");

  const sent = await test.call(
    "quickChat.send",
    { text: "What is a monad?", connectionId: connection.id, model: "fake-fast" },
    "c2",
  );
  const reply = await settled(test, sent.replyId);
  expect(reply).toMatchObject({
    role: "assistant",
    status: "complete",
    text: "Echo: What is a monad?",
    billing: "user_api_key",
    connectionLabel: "My OpenAI key",
    hostName: "Test Mac",
    model: "fake-fast",
    usage: { inputTokens: 12, outputTokens: 7, reasoningTokens: 0 },
  });
  expect(reply.firstTextMs).toBeGreaterThanOrEqual(0);
  const request = responsesCalls(test)[0];
  expect(request?.headers.authorization).toBe("Bearer sk-user-synthetic");
  expect(JSON.parse(request?.body ?? "{}")).toMatchObject({ store: false, stream: true });

  // A retried send with the same command id returns the same rows and calls nobody again.
  expect(
    await test.call(
      "quickChat.send",
      { text: "What is a monad?", connectionId: connection.id, model: "fake-fast" },
      "c2",
    ),
  ).toEqual(sent);
  expect(responsesCalls(test)).toHaveLength(1);

  const list = (await test.call("quickChat.list")).items;
  expect(list).toMatchObject([{ id: sent.chatId, title: "What is a monad?" }]);
  expect(test.store.snapshot().thread ?? []).toEqual([]);
  // The key lives only in the Keychain stand-in: not in the database, events or client views.
  const database = readFileSync(path.join(test.root, "store.db")).toString("latin1");
  expect(database).not.toContain("sk-user-synthetic");
  expect(JSON.stringify(test.events)).not.toContain("sk-user-synthetic");
  expect(JSON.stringify(await test.call("quickConnection.list"))).not.toContain("sk-user");
  expect([...test.keychain.values()].join()).toContain("sk-user-synthetic");
  // History is sent on the next turn; usage is summarized per connection and billing source.
  const second = await test.call(
    "quickChat.send",
    {
      chatId: sent.chatId,
      text: "Shorter please",
      connectionId: connection.id,
      model: "fake-fast",
    },
    "c3",
  );
  await settled(test, second.replyId);
  expect(JSON.parse(responsesCalls(test)[1]?.body ?? "{}").input).toHaveLength(3);
  expect(await test.call("quickChat.usage")).toEqual({
    items: [
      {
        connectionId: connection.id,
        billing: "user_api_key",
        replies: 2,
        inputTokens: 24,
        outputTokens: 14,
        uncertain: 0,
      },
    ],
  });
});

it("renames, deletes for real, and refuses a draft holding a known private value", async () => {
  const test = await fixture();
  const connection = await apiKeyConnection(test);
  const sent = await test.call(
    "quickChat.send",
    { text: "Plan a trip", connectionId: connection.id, model: "fake-fast" },
    "r1",
  );
  await settled(test, sent.replyId);
  expect(await test.call("quickChat.rename", { id: sent.chatId, title: "Trip" })).toMatchObject({
    title: "Trip",
  });
  await expect(
    test.call(
      "quickChat.send",
      {
        chatId: sent.chatId,
        text: "my key sk-user-synthetic",
        connectionId: connection.id,
        model: "fake-fast",
      },
      "r2",
    ),
  ).rejects.toThrow("private_value");
  expect(await test.call("quickChat.delete", { id: sent.chatId, confirmed: true })).toEqual({
    ok: true,
  });
  for (const table of ["quick_chats", "quick_messages", "quick_requests"])
    expect(test.store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
      n: 0,
    });
  expect(test.events.at(-1)).toMatchObject({ type: "quickChat.removed", aggregateId: sent.chatId });
  await expect(test.call("quickChat.get", { id: sent.chatId })).rejects.toThrow(
    "quick_chat_unavailable",
  );
});

it("stops on quota without paying elsewhere, and falls back only to an acknowledged destination", async () => {
  const test = await fixture();
  const connection = await apiKeyConnection(test);
  const local = await test.call("quickConnection.saveLocal", {
    label: "Local server",
    baseUrl: `${test.fake.url}/v1`,
  });
  expect(local).toMatchObject({ billing: "local", status: "ready", hasSecret: false });
  const first = await test.call(
    "quickChat.send",
    { text: "Hello", connectionId: connection.id, model: "fake-quota" },
    "q1",
  );
  expect(await settled(test, first.replyId)).toMatchObject({
    status: "failed",
    error: { code: "quota_exhausted" },
  });
  expect((await test.call("quickChat.get", { id: first.chatId })).messages).toHaveLength(2);
  expect((await test.call("quickConnection.list")).items[0]).toMatchObject({
    status: "quota_exhausted",
  });
  expect(test.fake.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(0);

  await expect(
    test.call("quickConnection.setFallback", {
      enabled: true,
      connectionId: local.id,
      model: "fake-fast",
    }),
  ).rejects.toThrow();
  expect(
    await test.call("quickConnection.setFallback", {
      enabled: true,
      connectionId: local.id,
      model: "fake-fast",
      acknowledged: true,
    }),
  ).toMatchObject({ fallback: { connectionId: local.id, model: "fake-fast" } });
  const second = await test.call(
    "quickChat.send",
    { chatId: first.chatId, text: "Again", connectionId: connection.id, model: "fake-quota" },
    "q2",
  );
  await settled(test, second.replyId);
  let messages: QuickMessage[] = [];
  for (let i = 0; i < 100; i++) {
    messages = (await test.call("quickChat.get", { id: first.chatId })).messages;
    if (messages.at(-1)?.status === "complete") break;
    await new Promise((done) => setTimeout(done, 20));
  }
  expect(messages.at(-1)).toMatchObject({
    status: "complete",
    fallbackFrom: second.replyId,
    billing: "local",
    connectionId: local.id,
    // The unanswered question travels with the new one, to the destination the person chose.
    text: "Echo: Hello\n\nAgain",
  });

  // Output already streamed before a limit: the reply is interrupted and never replayed.
  const partial = await test.call(
    "quickChat.send",
    { chatId: first.chatId, text: "More", connectionId: connection.id, model: "fake-midquota" },
    "q3",
  );
  expect(await settled(test, partial.replyId)).toMatchObject({
    status: "interrupted",
    text: "Partial",
  });
  await new Promise((done) => setTimeout(done, 100));
  expect((await test.call("quickChat.get", { id: first.chatId })).messages.at(-1)?.id).toBe(
    partial.replyId,
  );
  expect(await test.call("quickConnection.setFallback", { enabled: false })).not.toHaveProperty(
    "fallback",
  );
});

it("cancels, records cut-off streams, and marks replies abandoned by a restart as unresolved", async () => {
  const test = await fixture();
  const connection = await apiKeyConnection(test);
  const slow = await test.call(
    "quickChat.send",
    { text: "Count", connectionId: connection.id, model: "fake-slow" },
    "s1",
  );
  await new Promise((done) => setTimeout(done, 250));
  await test.call("quickChat.cancel", { chatId: slow.chatId, replyId: slow.replyId });
  expect(await settled(test, slow.replyId)).toMatchObject({
    status: "interrupted",
    error: { code: "cancelled" },
  });
  const cut = await test.call(
    "quickChat.send",
    { chatId: slow.chatId, text: "Go", connectionId: connection.id, model: "fake-cut" },
    "s2",
  );
  expect(await settled(test, cut.replyId)).toMatchObject({
    status: "interrupted",
    text: "Cut",
    error: { code: "stream_ended" },
  });
  const pending = await test.call(
    "quickChat.send",
    { chatId: slow.chatId, text: "Again", connectionId: connection.id, model: "fake-slow" },
    "s3",
  );
  // Simulate the host stopping mid-reply: the streaming row is left behind for the next start.
  test.store.database
    .prepare(
      "UPDATE quick_messages SET status='streaming', body=json_set(body,'$.status','streaming','$.text','') WHERE id=?",
    )
    .run(pending.replyId);
  test.reopen();
  const row = (await test.call("quickChat.get", { id: slow.chatId })).messages.find(
    (message: QuickMessage) => message.id === pending.replyId,
  );
  expect(row).toMatchObject({ status: "uncertain", error: { code: "host_restarted" } });
});

it("uses an Anthropic key and a local endpoint, discovering their models", async () => {
  const test = await fixture();
  const anthropic = await test.call("quickConnection.saveApiKey", {
    provider: "anthropic",
    label: "My Anthropic key",
    apiKey: "sk-ant-synthetic",
    confirmed: true,
  });
  expect(anthropic.models[0]).toMatchObject({
    id: "fake-fast",
    label: "Fake fake-fast",
    source: "discovered",
  });
  const sent = await test.call(
    "quickChat.send",
    { text: "Hello there", connectionId: anthropic.id, model: "fake-fast" },
    "a1",
  );
  expect(await settled(test, sent.replyId)).toMatchObject({
    status: "complete",
    text: "Echo: Hello there",
    provider: "anthropic",
    usage: { inputTokens: 9, outputTokens: 4 },
  });
  await expect(
    test.call("quickConnection.saveLocal", { label: "Remote", baseUrl: "http://example.com/v1" }),
  ).rejects.toThrow("quick_endpoint_invalid");
  const closed = createServer();
  await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((done) => closed.close(done));
  const unreachable = await test.call("quickConnection.saveLocal", {
    label: "Offline",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: ["my-model"],
  });
  expect(unreachable).toMatchObject({
    status: "ready",
    models: [{ id: "my-model", source: "configured" }],
  });
  const offline = await test.call(
    "quickChat.send",
    { text: "Anyone?", connectionId: unreachable.id, model: "my-model" },
    "a2",
  );
  expect(await settled(test, offline.replyId)).toMatchObject({
    status: "failed",
    error: { code: "unreachable" },
  });
});

async function toolConnections(test: Fixture) {
  let items: QuickConnection[] = [];
  await expect
    .poll(async () => {
      items = (await test.call("quickConnection.list")).items;
      return items.map((row) => `${row.provider}:${row.status}`);
    })
    .toEqual(["antigravity:ready", "claude:ready", "codex:ready"]);
  return items;
}
it("discovers signed-in tools from Settings definitions without database registrations", async () => {
  const test = await fixture({
    tools: true,
    definitions: async () => ({ definitions: fakeToolDefinitions as AgentDefinition[] }),
  });
  expect(test.store.snapshot(["agentDefinition"]).agentDefinition ?? []).toEqual([]);
  const connections = await toolConnections(test);
  expect(connections.every((row) => row.models.length > 0)).toBe(true);
});

it("runs on the coding tools signed in on this host, keeping one session per chat", async () => {
  const test = await fixture({ tools: true });
  const [agy, claude, codex] = await toolConnections(test);
  expect([agy, claude, codex]).toMatchObject([
    { kind: "coding_tool", label: "Antigravity", recommendedModel: "gemini-3.8-flash" },
    { label: "Claude Code", recommendedModel: "sonnet" },
    { label: "Codex", recommendedModel: "gpt-6.1-terra" },
  ]);
  expect(agy).toMatchObject({ billing: "tool_sign_in", hasSecret: false });
  // Listing models opens and closes a session but sends nothing.
  expect(test.tools.sends).toEqual([]);
  const model = agy?.recommendedModel ?? "";
  const first = await test.call(
    "quickChat.send",
    { text: "Hello", connectionId: agy?.id, model },
    "t1",
  );
  expect(await settled(test, first.replyId)).toMatchObject({
    status: "complete",
    text: "Echo: Hello",
    provider: "antigravity",
    billing: "tool_sign_in",
    hostName: "Test Mac",
    model: "gemini-3.8-flash",
    usage: { inputTokens: 20, outputTokens: 6 },
  });
  const second = await test.call(
    "quickChat.send",
    { chatId: first.chatId, text: "And again", connectionId: agy?.id, model },
    "t2",
  );
  expect(await settled(test, second.replyId)).toMatchObject({ text: "Echo: And again" });
  const chatOpens = () => test.tools.opens.filter((row) => row.conversationId === first.chatId);
  expect(chatOpens()).toHaveLength(1);
  expect(chatOpens()[0]).toMatchObject({ model: "gemini-3.8-flash" });
  expect(chatOpens()[0]).toMatchObject({ tools: true });
  expect(chatOpens()[0]?.instructions).toContain("quick_workspaces");
  expect(test.tools.sends.map((row) => row.text)).toEqual(["Hello", "And again"]);

  // A read-only lookup runs without asking and shows on the reply.
  const lookup = await test.call(
    "quickChat.send",
    { chatId: first.chatId, text: "lookup clicks", connectionId: agy?.id, model },
    "t3",
  );
  const looked = await settled(test, lookup.replyId);
  expect(looked).toMatchObject({
    status: "complete",
    tools: [{ name: "mcp__seoskill__seo_report", title: "Search Console report", status: "ok" }],
  });
  expect(looked.requests).toBeUndefined();
  expect(test.tools.allowed).toEqual([{ id: "ask-turn-3", automatic: true }]);

  // Switching model starts a new session that receives the earlier conversation once.
  const switched = await test.call(
    "quickChat.send",
    { chatId: first.chatId, text: "Third", connectionId: agy?.id, model: "gemini-3.8-pro" },
    "t4",
  );
  expect(await settled(test, switched.replyId)).toMatchObject({ text: "Echo: Third" });
  expect(chatOpens()).toHaveLength(2);
  expect(test.tools.sends.at(-1)?.text).toMatch(/^Earlier in this conversation:[\s\S]*Third$/);

  // A usage limit fails the reply without trying anywhere else.
  const limited = await test.call(
    "quickChat.send",
    { chatId: first.chatId, text: "limit", connectionId: claude?.id, model: "sonnet" },
    "t5",
  );
  expect(await settled(test, limited.replyId)).toMatchObject({
    status: "failed",
    error: { code: "quota_exhausted" },
  });

  // Removing a tool hides it until the person adds it back.
  await test.call("quickConnection.remove", { id: codex?.id, confirmed: true });
  expect(
    (await test.call("quickConnection.list")).items.map((row: QuickConnection) => row.provider),
  ).toEqual(["antigravity", "claude"]);
  expect(await test.call("quickConnection.addTool", { tool: "codex" })).toMatchObject({
    provider: "codex",
    status: "ready",
  });
});
it("asks the person before a tool acts and remembers Always allow", async () => {
  const test = await fixture({ tools: true });
  const [agy] = await toolConnections(test);
  const model = agy?.recommendedModel ?? "";
  const pending = async (replyId: string) => {
    let request: QuickRequest | undefined;
    await expect
      .poll(async () => {
        const { messages } = await test.call("quickChat.get", { id: chatId });
        request = (messages as QuickMessage[]).find((row) => row.id === replyId)?.requests?.[0];
        return request?.state;
      })
      .toBe("pending");
    return request as QuickRequest;
  };
  const first = await test.call(
    "quickChat.send",
    { text: "Use a tool", connectionId: agy?.id, model },
    "a1",
  );
  const chatId = first.chatId;
  expect(await pending(first.replyId)).toMatchObject({
    kind: "approval",
    title: "Send an email",
    toolName: "mcp__gmail__send_message",
    toolKind: "other",
  });
  await expect(
    test.call("quickChat.respond", {
      replyId: first.replyId,
      requestId: "nope",
      decision: "allow",
    }),
  ).rejects.toThrow("quick_request_unavailable");
  await test.call("quickChat.respond", {
    replyId: first.replyId,
    requestId: "ask-turn-1",
    decision: "deny",
  });
  expect(await settled(test, first.replyId)).toMatchObject({
    text: "Echo: Use a tool (not sent)",
    requests: [{ state: "denied" }],
  });

  const second = await test.call(
    "quickChat.send",
    { chatId, text: "Use a tool again", connectionId: agy?.id, model },
    "a2",
  );
  const request = await pending(second.replyId);
  await test.call("quickChat.respond", {
    replyId: second.replyId,
    requestId: request.id,
    decision: "always",
  });
  expect(await settled(test, second.replyId)).toMatchObject({
    text: "Echo: Use a tool again (sent)",
    requests: [{ state: "allowed" }],
  });
  expect((await test.call("quickConnection.list")).settings.allowedTools).toEqual([
    "mcp__gmail__send_message",
  ]);
  // Next time it runs without asking.
  const third = await test.call(
    "quickChat.send",
    { chatId, text: "Use a tool once more", connectionId: agy?.id, model },
    "a3",
  );
  expect(await settled(test, third.replyId)).toMatchObject({
    text: "Echo: Use a tool once more (sent)",
  });
  expect(test.tools.allowed.at(-1)).toEqual({ id: "ask-turn-3", automatic: true });
  await test.call("quickChat.forgetTool", { name: "mcp__gmail__send_message" });
  expect((await test.call("quickConnection.list")).settings.allowedTools).toEqual([]);

  // Servers: listed by name, `ask` by default. Allowing one skips its cards; turning one off
  // opens a new session without it.
  expect((await test.call("quickChat.servers")).items).toEqual([
    { name: "gmail", tools: ["claude"], access: "ask" },
    { name: "seoskill", tools: ["claude", "codex"], access: "ask" },
  ]);
  await test.call("quickChat.setServer", { name: "gmail", access: "allow" });
  const trusted = await test.call(
    "quickChat.send",
    { chatId, text: "Use a tool, trusted server", connectionId: agy?.id, model },
    "a5",
  );
  expect(await settled(test, trusted.replyId)).toMatchObject({
    text: "Echo: Use a tool, trusted server (sent)",
  });
  expect(test.tools.opens.at(-1)?.off).toBeUndefined();
  await test.call("quickChat.setServer", { name: "seoskill", access: "off" });
  await test.call("quickChat.setServer", { name: "gmail", access: "ask" });
  expect(
    (await test.call("quickChat.servers")).items.map((row: { access: string }) => row.access),
  ).toEqual(["ask", "off"]);
  const opened = test.tools.opens.length;
  const fewer = await test.call(
    "quickChat.send",
    { text: "Hello again", connectionId: agy?.id, model },
    "a6",
  );
  await settled(test, fewer.replyId);
  expect(test.tools.opens.length).toBe(opened + 1);
  expect(test.tools.opens.at(-1)).toMatchObject({ off: ["seoskill"] });

  // Stopping a reply that is waiting declines the request and marks it expired.
  const stopped = await test.call(
    "quickChat.send",
    { chatId, text: "Use a tool, then stop", connectionId: agy?.id, model },
    "a4",
  );
  await pending(stopped.replyId);
  await test.call("quickChat.cancel", { chatId, replyId: stopped.replyId });
  expect(await settled(test, stopped.replyId)).toMatchObject({
    status: "interrupted",
    requests: [{ state: "expired" }],
  });
});
it("marks a signed out coding tool and stops a running tool reply", async () => {
  const test = await fixture({ tools: true, signedOut: ["codex"] });
  await expect
    .poll(async () =>
      (await test.call("quickConnection.list")).items.map(
        (row: QuickConnection) => `${row.provider}:${row.status}`,
      ),
    )
    .toEqual(["antigravity:ready", "claude:ready", "codex:needs_sign_in"]);
  const { items } = await test.call("quickConnection.list");
  await expect(
    test.call("quickChat.send", { text: "Hi", connectionId: items[2].id, model: "x" }, "s1"),
  ).rejects.toThrow("quick_connection_needs_sign_in");
  const slow = await test.call(
    "quickChat.send",
    { text: "slow please", connectionId: items[1].id, model: "sonnet" },
    "s2",
  );
  await expect
    .poll(async () => (await test.call("quickChat.get", { id: slow.chatId })).messages[1].text)
    .not.toBe("");
  await test.call("quickChat.cancel", { chatId: slow.chatId, replyId: slow.replyId });
  expect(await settled(test, slow.replyId)).toMatchObject({ error: { code: "cancelled" } });
  // Without a tool runtime (as in tests and builds without one), no tool connections appear.
  const plain = await fixture();
  expect((await plain.call("quickConnection.list")).items).toEqual([]);
});

it("adds explicit, bounded workspace context and hands off without starting work", async () => {
  const test = await fixture();
  const folder = path.join(test.root, "repo");
  mkdirSync(path.join(folder, "docs"), { recursive: true });
  writeFileSync(
    path.join(folder, "docs/billing.md"),
    "# Billing\nInvoices are sent monthly by the billing worker.\n",
  );
  writeFileSync(path.join(folder, ".env"), "TOKEN=abc\n");
  writeFileSync(path.join(folder, "keys.ts"), "export const billing = 'sk-live-123';\n");
  const at = "2026-11-06T12:00:00.000Z";
  test.store.dispatch("project", () => ({
    result: {},
    events: [
      {
        eventId: "project:0",
        aggregateType: "project",
        aggregateId: "proj",
        type: "project.created",
        occurredAt: at,
        payload: {
          id: "proj",
          name: "Zolt",
          goal: "Ship billing",
          instructions: "Be careful",
          constraints: "",
          roots: [{ path: folder, label: "repo" }],
          hierarchyDepth: 0,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
        },
      },
    ],
  }));
  expect(await test.call("quickChat.files", { projectId: "proj", query: "" })).toEqual({
    items: [
      { path: "docs/billing.md", label: "docs/billing.md" },
      { path: "keys.ts", label: "keys.ts" },
    ],
    truncated: false,
  });
  const connection = await apiKeyConnection(test);
  const contextSources = [
    { id: "s1", kind: "workspace", projectId: "proj", label: "Zolt" },
    { id: "s2", kind: "brief", scope: { type: "project", id: "proj" }, label: "Zolt brief" },
    { id: "s3", kind: "file", projectId: "proj", path: ".env", label: ".env" },
  ];
  const sent = await test.call(
    "quickChat.send",
    {
      text: "How are billing invoices sent?",
      connectionId: connection.id,
      model: "fake-fast",
      contextSources,
    },
    "w1",
  );
  await settled(test, sent.replyId);
  const body = responsesCalls(test)[0]?.body ?? "";
  expect(body).toContain("Invoices are sent monthly");
  expect(body).toContain("Goal: Ship billing");
  expect(body).not.toContain("TOKEN=abc");
  expect(body).not.toContain("sk-live-123");
  const { chat, messages } = await test.call("quickChat.get", { id: sent.chatId });
  expect(chat.contextSources).toHaveLength(3);
  expect(
    messages[0].context.map((ref: { path?: string; label: string }) => ref.path ?? ref.label),
  ).toEqual(["docs/billing.md", "Zolt brief"]);
  expect(messages[0].contextNotes.join(" ")).toMatch(/secret|credential/);
  const again = await test.call(
    "quickChat.send",
    {
      chatId: sent.chatId,
      text: "And billing retries?",
      connectionId: connection.id,
      model: "fake-fast",
    },
    "w2",
  );
  await settled(test, again.replyId);
  const followUp = (await test.call("quickChat.get", { id: sent.chatId })).messages[2];
  expect(followUp.context.every((ref: { reused: boolean }) => ref.reused)).toBe(true);
  // Removing sources stops future retrieval.
  await test.call("quickChat.setContext", { id: sent.chatId, contextSources: [] });
  const third = await test.call(
    "quickChat.send",
    {
      chatId: sent.chatId,
      text: "Billing again?",
      connectionId: connection.id,
      model: "fake-fast",
    },
    "w3",
  );
  await settled(test, third.replyId);
  expect(responsesCalls(test)[2]?.body).not.toContain("<context source");

  const preview = await test.call("quickChat.handoffPreview", { id: sent.chatId });
  expect(preview.brief).toContain("How are billing invoices sent?");
  expect(preview.contextLabels).toContain("docs/billing.md");
  const handoff = await test.call(
    "quickChat.handoff",
    {
      id: sent.chatId,
      projectId: "proj",
      profileId: "profile-1",
      brief: preview.brief,
      confirmed: true,
    },
    "h1",
  );
  expect(test.threads).toEqual([
    expect.objectContaining({
      id: handoff.threadId,
      agentId: "profile-1",
      projectId: "proj",
      node: { type: "project", id: "proj" },
      kind: "main",
    }),
  ]);
  expect(responsesCalls(test)).toHaveLength(3);
  expect((await test.call("quickChat.get", { id: sent.chatId })).chat.handoffs).toHaveLength(1);
});

it("pins, marks unread/read, and archives quick chats via quickChat.update", async () => {
  const test = await fixture();
  const connection = await apiKeyConnection(test);
  const sent = await test.call(
    "quickChat.send",
    { text: "Pin and archive test", connectionId: connection.id, model: "fake-fast" },
    "q1",
  );
  await settled(test, sent.replyId);
  const initial = (await test.call("quickChat.get", { id: sent.chatId })).chat;

  const pinned = await test.call("quickChat.update", { id: sent.chatId, pinned: true }, "q-pin");
  expect(pinned).toMatchObject({ id: sent.chatId, pinned: true, updatedAt: initial.updatedAt });

  const unread = await test.call("quickChat.update", { id: sent.chatId, unread: true }, "q-unread");
  expect(unread).toMatchObject({ id: sent.chatId, pinned: true, unread: true });

  const follow = await test.call(
    "quickChat.send",
    {
      chatId: sent.chatId,
      text: "Follow-up",
      connectionId: connection.id,
      model: "fake-fast",
    },
    "q2",
  );
  await settled(test, follow.replyId);
  expect((await test.call("quickChat.get", { id: sent.chatId })).chat.unread).toBe(false);

  const archived = await test.call(
    "quickChat.update",
    { id: sent.chatId, archived: true },
    "q-archive",
  );
  expect(archived).toMatchObject({ id: sent.chatId, archived: true });
});
