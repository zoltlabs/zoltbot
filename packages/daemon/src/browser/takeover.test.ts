import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { handle } from "@zoltbot/core";
import type { DomainEvent } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import type { BrowserEngine, EnginePage } from "./engine.js";
import { BrowserHost } from "./host.js";
import { browserBinding } from "./runtime.js";
import { TAKEOVER_PREFIX, takeoverApi } from "./takeover.js";
import { controlFile, notesFile, parseInput } from "./takeover-files.js";

function setup(root: string) {
  const sent: unknown[] = [];
  const page: EnginePage = {
    url: () => "https://shop.example.test/account",
    frames: async () => async () => {},
    mouse: async (event) => {
      sent.push({ mouse: event });
    },
    key: async (event) => {
      sent.push({ key: event });
    },
    evaluate: async <T>() => undefined as T,
    onClose() {},
    onLoad() {},
  };
  let closed = false;
  const engine: BrowserEngine = {
    async launch() {
      return {
        endpoint: "/tmp/fake.sock",
        pages: () => [page],
        onPage() {},
        onPointer() {},
        async close() {
          closed = true;
        },
      };
    },
  };
  const host = new BrowserHost(engine, undefined, path.join(root, "scratch"));
  mkdirSync(path.join(root, "work"), { recursive: true });
  const binding = browserBinding(
    root,
    path.join(root, "work"),
    { mode: "background" },
    undefined,
    true,
  );
  return { host, binding, sent, closed: () => closed };
}

const cards = (f: Awaited<ReturnType<typeof runtimeFixture>>) =>
  (f.store
    .snapshot(["interaction"])
    .interaction?.filter((row) => String(row.id).startsWith(TAKEOVER_PREFIX)) ?? []) as {
    id: string;
    state: string;
    items?: { prompt?: string }[];
    resolution?: { action?: string };
  }[];

it("Take over raises a gate, lets the owner's input through, and Hand back leaves the agent a note", async () => {
  const f = await runtimeFixture();
  try {
    const { host, binding, sent } = setup(f.root);
    const published: DomainEvent[] = [];
    const takeover = takeoverApi({
      store: f.store,
      host: () => host,
      publish: (events) => published.push(...events),
    });
    await host.ensure(binding, "thread");

    // Before Take over, input is refused.
    await expect(takeover.input("thread", { kind: "key", type: "down", key: "a" })).rejects.toThrow(
      "browser_not_in_control",
    );

    expect(takeover.take("thread")).toEqual({
      control: true,
      url: "https://shop.example.test/account",
    });
    const [card] = cards(f);
    expect(card).toMatchObject({
      type: "gate",
      state: "pending",
      urgency: "blocking",
      title: "You’re in control of the browser",
      items: [{ options: [{ id: "hand-back", label: "Hand back" }] }],
    });
    expect(String(card?.items?.[0]?.prompt)).toMatch(/ waits until you hand it back\.$/);
    expect(existsSync(controlFile(binding))).toBe(true);
    expect(host.view("viewer", "thread", true, () => {})).toMatchObject({ control: true });
    // A second Take over keeps the one card.
    takeover.take("thread");
    expect(cards(f)).toHaveLength(1);

    await takeover.input("thread", { kind: "mouse", type: "down", x: 10, y: 20, button: "left" });
    await takeover.input("thread", { kind: "key", type: "down", key: "s" });
    expect(sent).toEqual([
      { mouse: { type: "down", x: 10, y: 20, button: "left" } },
      { key: { type: "down", key: "s" } },
    ]);
    // What the owner typed is in no event and no card.
    expect(JSON.stringify(published)).not.toContain('"key":"s"');

    expect(takeover.handBack("thread")).toEqual({
      control: false,
      url: "https://shop.example.test/account",
    });
    expect(cards(f)[0]).toMatchObject({ state: "answered" });
    expect(existsSync(controlFile(binding))).toBe(false);
    expect(readFileSync(notesFile(binding), "utf8")).toBe(
      `${JSON.stringify({ text: "The owner used the browser and handed it back at https://shop.example.test/account." })}\n`,
    );
    await expect(takeover.input("thread", { kind: "key", type: "down", key: "a" })).rejects.toThrow(
      "browser_not_in_control",
    );
  } finally {
    f.close();
  }
});

it("answering the card elsewhere hands back, and a closed browser withdraws the card", async () => {
  const f = await runtimeFixture();
  try {
    const { host, binding, closed } = setup(f.root);
    const takeover = takeoverApi({ store: f.store, host: () => host });
    await host.ensure(binding, "thread");

    takeover.take("thread");
    const id = String(cards(f)[0]?.id);
    const before = f.store.lastSeq();
    f.store.dispatch(`answer:${id}`, (state) =>
      handle(
        state,
        {
          type: "answer",
          id,
          version: 1,
          answer: {
            action: "accept",
            answers: { choice: { options: ["hand-back"] } },
            by: { kind: "human", id: "local-owner" },
            at,
          },
        },
        { commandId: `answer:${id}`, at, actor: { kind: "human", id: "local-owner" } },
      ),
    );
    takeover.observe(f.store.eventsSince(before));
    expect(host.controller("thread")).toBeUndefined();
    expect(existsSync(controlFile(binding))).toBe(false);
    expect(existsSync(notesFile(binding))).toBe(true);

    takeover.take("thread");
    await host.close(binding.id);
    expect(closed()).toBe(true);
    expect(
      cards(f)
        .map((card) => card.resolution?.action)
        .sort(),
    ).toEqual(["accept", "cancel"]);
  } finally {
    f.close();
  }
});

it("a card left open by a stopped daemon is withdrawn, and a stale control file can't block the agent", async () => {
  const f = await runtimeFixture();
  try {
    const first = setup(f.root);
    takeoverApi({ store: f.store, host: () => first.host });
    await first.host.ensure(first.binding, "thread");
    takeoverApi({ store: f.store, host: () => first.host }).take("thread");
    // The daemon stops without handing back: a new host and API start from the same data.
    const again = setup(f.root);
    takeoverApi({ store: f.store, host: () => again.host });
    expect(cards(f).map((card) => card.resolution?.action)).toEqual(["cancel"]);
    expect(existsSync(controlFile(first.binding))).toBe(true);
    await again.host.ensure(first.binding, "thread");
    expect(existsSync(controlFile(first.binding))).toBe(false);
  } finally {
    f.close();
  }
});

it("accepts only well-formed input and never echoes keys in errors", () => {
  expect(parseInput({ kind: "mouse", type: "wheel", x: 1, y: 2, deltaY: 40 })).toEqual({
    kind: "mouse",
    type: "wheel",
    x: 1,
    y: 2,
    deltaY: 40,
  });
  for (const bad of [
    { kind: "mouse", type: "down", x: -1, y: 2 },
    { kind: "mouse", type: "down", x: Number.NaN, y: 2 },
    { kind: "mouse", type: "click", x: 1, y: 2 },
    { kind: "mouse", type: "down", x: 1, y: 2, button: "back" },
    { kind: "key", type: "down", key: "secret-password-that-is-too-long-to-be-a-key" },
    { kind: "key", type: "press", key: "a" },
    null,
  ])
    expect(() => parseInput(bad)).toThrow(/^browser_input_invalid$/);
});
