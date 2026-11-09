import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DomainState, handle } from "@zoltbot/core";
import { KnowledgeItemSchema, parse } from "@zoltbot/protocol";
import { openStore, type Store } from "@zoltbot/store";
import { afterEach, expect, it } from "vitest";
import { knowledgeApi } from "./knowledge-api.js";

const at = "2026-11-04T00:00:00Z";
const actor = { kind: "human" as const, id: "local-owner" };
const roots: string[] = [],
  stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "zolt-knowledge-api-"));
  roots.push(dir);
  const store = await openStore(path.join(dir, "test.db"));
  stores.push(store);
  store.dispatch("project", (s) =>
    handle(
      s,
      {
        type: "create",
        kind: "project",
        value: {
          id: "p",
          name: "P",
          goal: "",
          instructions: "",
          constraints: "",
          roots: [],
          hierarchyDepth: 0,
          tags: [],
          requireCodeReview: false,
          skipFinalGateWhenReviewed: false,
          archived: false,
          createdAt: at,
        },
      },
      { commandId: "project", at, actor },
    ),
  );
  const published: unknown[] = [];
  const api = knowledgeApi({
    store,
    publish: (events) => published.push(...events),
    checkPublic: async () => (_s: DomainState) => {},
  });
  const item = parse(KnowledgeItemSchema, {
    id: "k",
    scope: { type: "project", id: "p" },
    kind: "decision",
    title: "Units",
    body: "Use grams.",
    tags: [],
    sources: [],
    status: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    owner: actor,
    verification: "human",
    writer: actor,
  });
  return { api, store, item, published };
}
it("uses receipts for retries, publishes once, retains drafts on stale CAS and archive history", async () => {
  const { api, item, published } = await fixture();
  const first = await api("knowledge.upsert", { value: item, expectedRevision: 0 }, "first");
  expect(await api("knowledge.upsert", { value: item, expectedRevision: 0 }, "first")).toEqual(
    first,
  );
  expect(published).toHaveLength(1);
  await expect(
    api("knowledge.upsert", { value: { ...item, body: "draft" }, expectedRevision: 0 }, "stale"),
  ).rejects.toThrow("conflict");
  // An archive that names a revision someone already moved past is refused, like an upsert.
  await expect(
    api("knowledge.archive", { id: item.id, expectedRevision: 0 }, "stale-archive"),
  ).rejects.toThrow("conflict");
  await api("knowledge.archive", { id: item.id, expectedRevision: 1 }, "archive");
  expect(await api("knowledge.revisions", { id: item.id })).toMatchObject([
    { revision: 2, status: "archived" },
    { revision: 1, body: "Use grams." },
  ]);
  await expect(api("knowledge.list", {})).rejects.toThrow();
  expect(await api("knowledge.list", { scope: item.scope, status: "archived" })).toMatchObject({
    items: [{ id: "k" }],
  });
});
it("fails closed on widened scopes and malformed preview syntax without touching another project", async () => {
  const { api, item } = await fixture();
  await api("knowledge.upsert", { value: item, expectedRevision: 0 }, "first");
  expect(
    await api("knowledge.preview", { scope: item.scope, query: '" OR * : (', remainingTokens: 0 }),
  ).toMatchObject({ pack: { included: [] } });
  await expect(
    api("knowledge.list", { scope: { type: "project", id: "foreign" } }),
  ).rejects.toThrow("scope_unavailable");
  await expect(
    api("knowledge.exclude", { taskId: "missing", ids: ["k"], confirmed: false }, "exclude"),
  ).rejects.toThrow("confirmation_required");
});
