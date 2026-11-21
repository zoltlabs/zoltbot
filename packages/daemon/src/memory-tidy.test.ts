// M3: the nightly tidy-up asks the local model for merged text and leaves proposals for review.
import { upsertKnowledge } from "@zoltbot/knowledge";
import { MEMORY_TIDY_SETTING } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { knowledgeWriteFixture } from "./knowledge-write-fixture.js";
import { memoryTidyTimer, runMemoryTidy } from "./memory-tidy.js";
import type { InferenceAdapter } from "./quick-chat/providers.js";

const owner = { kind: "human" as const, id: "owner" };
const at = "2026-11-04T00:00:00.000Z";
function entry(id: string, body: string, updatedAt = at) {
  return {
    id,
    scope: { type: "project" as const, id: "a" },
    kind: "lesson" as const,
    title: "Builds",
    body,
    tags: [],
    status: "active" as const,
    owner,
    writer: owner,
    verification: "human" as const,
    sources: [],
    revision: 1,
    createdAt: at,
    updatedAt,
  };
}
function fakeModel(reply: string) {
  const prompts: string[] = [];
  const adapter = {
    async stream(request: { turns: { text: string }[]; onText(delta: string): void }) {
      prompts.push(request.turns[0]?.text ?? "");
      request.onText(reply);
      return {};
    },
  } as unknown as InferenceAdapter;
  return { adapter, prompts };
}
async function setup() {
  const k = await knowledgeWriteFixture();
  const save = (value: ReturnType<typeof entry>) =>
    k.f.store.dispatch(`save:${value.id}`, (state) =>
      upsertKnowledge(state, value, 0, {
        commandId: `save:${value.id}`,
        at: value.updatedAt,
        actor: owner,
      }),
    );
  save(entry("old", "Builds reuse the turbo cache on every branch."));
  save(entry("fresh", "Every branch build reuses the turbo cache.", "2026-11-10T00:00:00.000Z"));
  save(entry("other", "Sam is on leave until 3 Dec."));
  return k;
}
const merged = JSON.stringify({
  title: "Builds",
  body: "Every branch build reuses the turbo cache.",
});
const night = () => new Date(2026, 10, 21, 3, 30);

describe("memory tidy-up", () => {
  it("proposes one merge per overlapping pair, once a night", async () => {
    const k = await setup();
    try {
      const model = fakeModel(merged);
      const published: unknown[] = [];
      const host = {
        store: k.f.store,
        publish: (events: unknown[]) => published.push(...events),
        router: async () => ({ adapter: model.adapter, model: "small" }),
        containsSecret: async () => false,
        now: night,
      };
      expect(await runMemoryTidy(host)).toBe(1);
      expect(JSON.parse(model.prompts[0] ?? "").entries[0]).toMatchObject({
        authoritative: true,
        title: "Builds",
      });
      const proposals = k.f.store.snapshot(["knowledgeProposal"]).knowledgeProposal ?? [];
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        state: "pending",
        itemId: "fresh",
        merges: { id: "old" },
        why: "tidy_merge",
        writer: { kind: "system", id: "memory-tidy" },
      });
      expect(published.length).toBeGreaterThan(0);
      // Already done tonight.
      expect(await runMemoryTidy(host)).toBeUndefined();
      expect(model.prompts).toHaveLength(1);
    } finally {
      k.f.close();
    }
  });

  it("does nothing when turned off, and waits for a model when none is connected", async () => {
    const k = await setup();
    try {
      const base = { store: k.f.store, publish: () => {}, now: night };
      expect(await runMemoryTidy({ ...base, router: async () => undefined })).toBeUndefined();
      // Not marked done: a later tick with a model still runs tonight.
      const model = fakeModel(merged);
      k.f.store.dispatch("setting", () => ({
        events: [
          {
            eventId: "setting:0",
            aggregateType: "settings",
            aggregateId: MEMORY_TIDY_SETTING,
            type: "settings.created",
            occurredAt: at,
            payload: { key: MEMORY_TIDY_SETTING, value: false },
          },
        ] as never[],
        result: { ok: true },
      }));
      const router = async () => ({ adapter: model.adapter, model: "small" });
      expect(await runMemoryTidy({ ...base, router })).toBeUndefined();
      expect(model.prompts).toHaveLength(0);
    } finally {
      k.f.close();
    }
  });

  it("skips replies it can't use and merges that hold a secret", async () => {
    const k = await setup();
    try {
      const host = {
        store: k.f.store,
        publish: () => {},
        now: night,
        router: async () => ({ adapter: fakeModel("no json").adapter, model: "small" }),
      };
      expect(await runMemoryTidy(host)).toBe(0);
      // The next night doesn't ask about the same pair again.
      const asked = fakeModel("no json");
      expect(
        await runMemoryTidy({
          ...host,
          now: () => new Date(2026, 10, 22, 3, 30),
          router: async () => ({ adapter: asked.adapter, model: "small" }),
        }),
      ).toBe(0);
      expect(asked.prompts).toHaveLength(0);
      const k2 = await setup();
      try {
        expect(
          await runMemoryTidy({
            ...host,
            store: k2.f.store,
            router: async () => ({ adapter: fakeModel(merged).adapter, model: "small" }),
            containsSecret: async () => true,
          }),
        ).toBe(0);
      } finally {
        k2.f.close();
      }
    } finally {
      k.f.close();
    }
  });

  it("tries again later when every model call fails", async () => {
    const k = await setup();
    try {
      const broken = {
        async stream() {
          throw new Error("offline");
        },
      } as unknown as InferenceAdapter;
      const host = {
        store: k.f.store,
        publish: () => {},
        now: night,
        router: async () => ({ adapter: broken, model: "small" }),
      };
      expect(await runMemoryTidy(host)).toBe(0);
      const model = fakeModel(merged);
      expect(
        await runMemoryTidy({
          ...host,
          router: async () => ({ adapter: model.adapter, model: "small" }),
        }),
      ).toBe(1);
    } finally {
      k.f.close();
    }
  });

  it("waits until 3 a.m. local time", async () => {
    const k = await setup();
    const model = fakeModel(merged);
    let hour = 1;
    const timer = memoryTidyTimer({
      store: k.f.store,
      publish: () => {},
      router: async () => ({ adapter: model.adapter, model: "small" }),
      now: () => new Date(2026, 10, 21, hour),
    });
    try {
      timer.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(model.prompts).toHaveLength(0);
      hour = 3;
      timer.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(model.prompts).toHaveLength(1);
    } finally {
      await timer.close();
      k.f.close();
    }
  });
});
