import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { parseEvent } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageApi } from "./message-api.js";

let root: string, store: Store;
const sent: { params: Record<string, unknown>; commandId: string }[] = [];
beforeEach(async () => {
  mkdirSync(".cache/tests", { recursive: true });
  root = mkdtempSync(path.resolve(".cache/tests/message-api-"));
  store = await openStore(path.join(root, "test.db"));
  sent.length = 0;
  const seed = (kind: "agentDefinition" | "agent" | "thread", value: Record<string, unknown>) =>
    store.dispatch(`seed-${kind}-${value.id}`, () => ({
      events: [
        parseEvent({
          eventId: `seed-${kind}-${value.id}:0`,
          commandId: `seed-${kind}-${value.id}`,
          aggregateType: kind,
          aggregateId: String(value.id),
          type: `${kind}.updated`,
          occurredAt: "2026-11-08T10:00:00Z",
          payload: value,
        }),
      ],
      result: {},
    }));
  seed("agentDefinition", {
    id: "sample",
    displayName: "Sample",
    adapter: "acp",
    binaryNames: [],
    versionCommand: [],
    launch: { command: "fake", args: [], env: {} },
    testedVersions: "1.0.0",
    defaults: { permissionProfile: "workspace_write" },
    staticCapabilities: {},
    nativeSessionRoots: [],
    experimental: false,
  });
  for (const id of ["source", "target"]) {
    seed("agent", {
      id: `agent-${id}`,
      definitionId: "sample",
      name: id,
      avatar: "A",
      kind: "profile",
      permissionProfile: "workspace_write",
      instructions: "",
      hidden: false,
      archived: false,
    });
    seed("thread", {
      id,
      agentId: `agent-${id}`,
      kind: "main",
      title: id,
      titleSource: "human",
      pinned: false,
      archived: false,
      createdAt: "2026-11-08T09:00:00Z",
      lastActivityAt: "2026-11-08T10:00:00Z",
    });
  }
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

const api = () =>
  messageApi({
    store,
    publish: () => {},
    send: async (_method, params, commandId) => {
      sent.push({ params, commandId });
      return {
        id: `item-${sent.length}`,
        disposition: params.mode === "steer" ? "started" : "queued",
      };
    },
  });
const message = (extra: Record<string, unknown> = {}) => ({
  id: "msg-1",
  thread: "target",
  fromThread: "source",
  from: { kind: "human", id: "local-owner" },
  to: [{ kind: "agent", id: "agent-target" }],
  kind: "message",
  expectsReply: false,
  priority: "normal",
  delivery: "next_turn",
  root: "msg-1",
  hops: 0,
  ttlHops: 6,
  origin: "human",
  body: [{ type: "text", text: "Use the staging database for this." }],
  createdAt: "2026-11-08T10:00:00Z",
  ...extra,
});

describe("message.send", () => {
  it("records the message and delivers it like typing in the chat, once per command", async () => {
    const call = api();
    const result = await call("message.send", { message: message() }, "c1");
    expect(result).toEqual({
      messageId: "msg-1",
      deliveries: [
        expect.objectContaining({ id: "item-1", toAgentId: "agent-target", state: "queued" }),
      ],
    });
    expect(sent[0]).toEqual({
      params: {
        threadId: "target",
        input: [{ type: "text", text: "Use the staging database for this." }],
        mode: "queue",
      },
      commandId: "c1:send",
    });
    await call("message.send", { message: message() }, "c1");
    expect(sent[1]?.commandId).toBe("c1:send");
    expect(store.snapshot(["message"]).message).toHaveLength(1);
    expect(await call("message.list", {})).toEqual({
      items: [expect.objectContaining({ id: "msg-1", origin: "human", thread: "target" })],
    });
  });

  it("steers a running turn when asked", async () => {
    const result = (await api()(
      "message.send",
      { message: message({ delivery: "steer" }) },
      "c2",
    )) as {
      deliveries: { state: string }[];
    };
    expect(sent[0]?.params.mode).toBe("steer");
    expect(result.deliveries[0]?.state).toBe("delivered");
  });

  it("refuses agent-origin, wrong-recipient, interrupt and non-text messages", async () => {
    const call = api();
    for (const [extra, code] of [
      [{ origin: "agent", from: { kind: "agent", id: "agent-source" } }, "human_message_required"],
      [{ to: [{ kind: "agent", id: "agent-source" }] }, "message_target_mismatch"],
      [{ delivery: "interrupt" }, "invalid_message_delivery"],
      [{ body: [{ type: "fileRef", path: "/etc/hosts" }] }, "text_message_required"],
      [{ thread: "missing" }, "not_found: thread"],
    ] as const)
      await expect(
        call("message.send", { message: message(extra) }, `bad-${code}`),
      ).rejects.toThrow(code);
    expect(sent).toEqual([]);
  });
});
