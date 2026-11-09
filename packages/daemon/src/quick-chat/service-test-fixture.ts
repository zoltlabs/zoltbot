import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import type {
  AgentDefinition,
  DomainEvent,
  QuickConnection,
  QuickMessage,
} from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterEach } from "vitest";
import {
  type FakeProviders,
  startFakeProviders,
} from "../../../../tools/fakes/src/quick-chat-providers.js";
import {
  type FakeToolLog,
  fakeToolDefinitions,
  fakeToolRuntime,
} from "../../../../tools/fakes/src/quick-chat-tools.js";
import { KeychainSecrets } from "../secrets.js";
import { type QuickChatService, quickChatService } from "./service.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
export interface Fixture {
  root: string;
  store: Store;
  fake: FakeProviders;
  events: DomainEvent[];
  threads: Record<string, unknown>[];
  tools: FakeToolLog;
  keychain: Map<string, string>;
  service: QuickChatService;
  // biome-ignore lint/suspicious/noExplicitAny: RPC results are checked by the assertions below.
  call(method: string, params?: Record<string, unknown>, commandId?: string): Promise<any>;
  reopen(): QuickChatService;
}
export async function fixture(
  options: {
    tools?: boolean;
    signedOut?: string[];
    definitions?: () => Promise<{ definitions: AgentDefinition[] }>;
  } = {},
): Promise<Fixture> {
  mkdirSync(".cache/tests", { recursive: true });
  const root = mkdtempSync(path.resolve(".cache/tests/quick-"));
  const store = await openStore(path.join(root, "store.db"));
  const fake = await startFakeProviders();
  const keychain = new Map<string, string>();
  const vault = new KeychainSecrets(async (request) => {
    if (request.op === "put" || request.op === "replace")
      keychain.set(request.account, request.value ?? "");
    if (request.op === "remove") keychain.delete(request.account);
    return { ok: true, value: keychain.get(request.account), found: keychain.has(request.account) };
  });
  const remembered: string[] = [];
  const events: DomainEvent[] = [];
  const threads: Record<string, unknown>[] = [];
  const tools = fakeToolRuntime(options.signedOut ? { signedOut: options.signedOut } : {});
  if (options.tools && !options.definitions)
    store.dispatch("definitions", () => ({
      result: {},
      events: fakeToolDefinitions.map((value, index) => ({
        eventId: `definition:${index}`,
        aggregateType: "agentDefinition",
        aggregateId: value.id,
        type: "agentDefinition.created",
        occurredAt: "2026-11-06T12:00:00.000Z",
        payload: value,
      })),
    }));
  const create = () =>
    quickChatService({
      store,
      publish: (batch) => events.push(...batch),
      vault,
      privacy: {
        async prepareData(value) {
          if (remembered.some((secret) => JSON.stringify(value).includes(secret)))
            throw new Error("private_value_requires_secure_field");
          return () => {};
        },
        async containsSecret(value) {
          return /sk-live-|BEGIN [A-Z ]*PRIVATE KEY/.test(JSON.stringify(value));
        },
        remember: (value) => remembered.push(value),
      },
      createThread: async (value) => {
        threads.push(value);
        return value;
      },
      endpoints: { openai: `${fake.url}/v1`, anthropic: fake.url },
      ...(options.tools
        ? {
            tools: tools.runtime,
            servers: () => [
              { name: "gmail", tools: ["claude" as const] },
              { name: "seoskill", tools: ["claude" as const, "codex" as const] },
            ],
          }
        : {}),
      ...(options.definitions ? { definitions: options.definitions } : {}),
      hostName: "Test Mac",
    });
  let service = create();
  const test: Fixture = {
    root,
    store,
    fake,
    events,
    threads,
    tools: tools.log,
    keychain,
    get service() {
      return service;
    },
    call: (method, params = {}, commandId) => service.api(method, params, commandId),
    reopen() {
      service.close();
      service = create();
      return service;
    },
  };
  cleanups.push(async () => {
    service.close();
    await fake.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return test;
}
export async function settled(test: Fixture, replyId: string): Promise<QuickMessage> {
  for (let i = 0; i < 200; i++) {
    const row = test.store.database
      .prepare("SELECT body FROM quick_messages WHERE id=?")
      .get(replyId) as { body: string } | undefined;
    const message = row && (JSON.parse(row.body) as QuickMessage);
    if (message && message.status !== "streaming") return message;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error("reply did not settle");
}
export const responsesCalls = (test: Fixture) =>
  test.fake.requests.filter((request) => request.path === "/v1/responses");
export async function apiKeyConnection(test: Fixture): Promise<QuickConnection> {
  return test.call("quickConnection.saveApiKey", {
    provider: "openai",
    label: "My OpenAI key",
    apiKey: "sk-user-synthetic",
    confirmed: true,
  });
}
