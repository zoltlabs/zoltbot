// M3: nightly tidy-up finds overlapping entries and proposes one merge per pair.
import { applyEvents, type DomainState } from "@zoltbot/core";
import type { KnowledgeItem } from "@zoltbot/protocol";
import { describe, expect, it } from "vitest";
import { parseTidyMerge, proposeTidyMerge, tidyCandidates, tidyFingerprint } from "./tidy.js";
import { decideProposal } from "./writes.js";

const at = "2026-11-04T00:00:00Z";
const later = "2026-11-10T00:00:00Z";
const owner = { kind: "human" as const, id: "owner" };
const tidy = { kind: "system" as const, id: "memory-tidy" };
function item(id: string, changes: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id,
    scope: { type: "project", id: "a" },
    title: "Builds",
    body: "Builds reuse the turbo cache on every branch.",
    kind: "lesson",
    status: "active",
    tags: [],
    sources: [],
    revision: 1,
    owner,
    verification: "human",
    writer: owner,
    createdAt: at,
    updatedAt: at,
    ...changes,
  };
}
const project = (id: string) => ({
  id,
  name: id,
  goal: "",
  instructions: "",
  constraints: "",
  roots: [],
  hierarchyDepth: 3,
  tags: [],
  requireCodeReview: false,
  skipFinalGateWhenReviewed: false,
  archived: false,
  createdAt: at,
});
const state = (...items: KnowledgeItem[]): DomainState => ({
  project: [project("a"), project("b")],
  knowledge: items as never[],
  knowledgeProposal: [],
});
const merged = { title: "Builds", body: "Builds reuse the turbo cache on every branch and in CI." };

describe("tidy candidates", () => {
  it("pairs overlapping entries in one scope and keeps the newer one", () => {
    const old = item("old", { tags: ["ci"] });
    const fresh = item("fresh", {
      body: "Every branch build reuses the turbo cache.",
      updatedAt: later,
    });
    const other = item("other", { title: "Leave", body: "Sam is on leave until 3 Dec." });
    const elsewhere = item("elsewhere", { scope: { type: "project", id: "b" } });
    const pairs = tidyCandidates(state(old, fresh, other, elsewhere));
    expect(pairs.map((pair) => [pair.keep.id, pair.drop.id])).toEqual([["fresh", "old"]]);
  });

  it("pairs entries with the same key even when their words differ", () => {
    const a = item("a", { key: "deploy-day", body: "Deploys go out on Tuesday." });
    const b = item("b", { key: "deploy-day", body: "Ship releases midweek.", updatedAt: later });
    expect(tidyCandidates(state(a, b))).toHaveLength(1);
  });

  it("keeps a pinned entry, skips busy and archived ones, and never re-offers a decided pair", () => {
    const pinned = item("pinned", { pinned: true });
    const fresh = item("fresh", { updatedAt: later });
    expect(tidyCandidates(state(pinned, fresh))[0]).toMatchObject({
      keep: { id: "pinned" },
      drop: { id: "fresh" },
    });
    expect(tidyCandidates(state(item("x", { status: "archived" }), fresh))).toEqual([]);
    const s = state(item("old"), fresh);
    const pair = tidyCandidates(s)[0];
    if (!pair) throw new Error("no pair");
    const proposed = applyEvents(
      s,
      proposeTidyMerge(s, pair, merged, { commandId: "tidy", at: later, actor: tidy }).events,
    );
    // Pending: both entries are busy. Rejected: the same revisions are never offered again.
    expect(tidyCandidates(proposed)).toEqual([]);
    const rejected = applyEvents(
      proposed,
      decideProposal(
        proposed,
        { id: `proposal-${pair.fingerprint}`, decision: "reject" },
        { commandId: "no", at: later, actor: owner },
      ).events,
    );
    expect(tidyCandidates(rejected)).toEqual([]);
    expect(tidyFingerprint(pair.keep, pair.drop)).toBe(tidyFingerprint(pair.drop, pair.keep));
  });

  it("caps the pairs a night and uses each entry once", () => {
    const items = Array.from({ length: 50 }, (_, n) =>
      item(`i${n}`, { updatedAt: `2026-11-${String((n % 20) + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    const pairs = tidyCandidates(state(...items));
    expect(pairs).toHaveLength(20);
    const ids = pairs.flatMap((pair) => [pair.keep.id, pair.drop.id]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("tidy merge", () => {
  it("accepting revises the kept entry, archives the other and keeps both sources", () => {
    const old = item("old", {
      sources: [{ kind: "url", ref: "https://example.com/a" }],
      tags: ["ci"],
    });
    const fresh = item("fresh", {
      updatedAt: later,
      sources: [{ kind: "url", ref: "https://example.com/b" }],
    });
    const s = state(old, fresh);
    const pair = tidyCandidates(s)[0];
    if (!pair) throw new Error("no pair");
    const outcome = proposeTidyMerge(s, pair, merged, {
      commandId: "tidy",
      at: later,
      actor: tidy,
    });
    expect(outcome.result).toMatchObject({
      op: "revise",
      itemId: "fresh",
      merges: { id: "old", revision: 1 },
      why: "tidy_merge",
      tags: ["ci"],
    });
    const proposed = applyEvents(s, outcome.events);
    const accepted = applyEvents(
      proposed,
      decideProposal(
        proposed,
        { id: `proposal-${pair.fingerprint}`, decision: "accept" },
        { commandId: "yes", at: later, actor: owner },
      ).events,
    );
    const rows = new Map((accepted.knowledge ?? []).map((row) => [row.id, row]));
    expect(rows.get("fresh")).toMatchObject({ body: merged.body, revision: 2, status: "active" });
    expect((rows.get("fresh")?.sources as unknown[]).length).toBe(2);
    expect(rows.get("old")).toMatchObject({ status: "archived", revision: 2 });
  });

  it("accepts a merge of two entries that share a key, and skips entries with different keys", () => {
    const old = item("old", { key: "cache" });
    const fresh = item("fresh", { key: "cache", updatedAt: later });
    const s = state(old, fresh);
    const pair = tidyCandidates(s)[0];
    if (!pair) throw new Error("no pair");
    const proposed = applyEvents(
      s,
      proposeTidyMerge(s, pair, merged, { commandId: "tidy", at: later, actor: tidy }).events,
    );
    const accepted = applyEvents(
      proposed,
      decideProposal(
        proposed,
        { id: `proposal-${pair.fingerprint}`, decision: "accept" },
        { commandId: "yes", at: later, actor: owner },
      ).events,
    );
    const rows = new Map((accepted.knowledge ?? []).map((row) => [row.id, row]));
    expect(rows.get("fresh")).toMatchObject({ key: "cache", body: merged.body });
    expect(rows.get("old")).toMatchObject({ status: "archived" });
    expect(tidyCandidates(state(item("a", { key: "x" }), item("b", { key: "y" })))).toEqual([]);
    expect(
      tidyCandidates(state(item("a"), item("b", { validUntil: "2027-01-01T00:00:00.000Z" }))),
    ).toEqual([]);
  });

  it("refuses the merge when the folded-in entry changed after it was proposed", () => {
    const s = state(item("old"), item("fresh", { updatedAt: later }));
    const pair = tidyCandidates(s)[0];
    if (!pair) throw new Error("no pair");
    const proposed = applyEvents(
      s,
      proposeTidyMerge(s, pair, merged, { commandId: "tidy", at: later, actor: tidy }).events,
    );
    const edited = {
      ...proposed,
      knowledge: (proposed.knowledge ?? []).map((row) =>
        row.id === "old" ? { ...row, revision: 2 } : row,
      ),
    };
    expect(() =>
      decideProposal(
        edited,
        { id: `proposal-${pair.fingerprint}`, decision: "accept" },
        { commandId: "yes", at: later, actor: owner },
      ),
    ).toThrow("knowledge_revision_conflict");
    // Proposing on stale candidates writes nothing.
    expect(
      proposeTidyMerge(edited, pair, merged, { commandId: "again", at: later, actor: tidy }).events,
    ).toEqual([]);
  });

  it("reads only a usable JSON reply", () => {
    expect(parseTidyMerge('Here: {"title":"A","body":"B"}')).toEqual({ title: "A", body: "B" });
    expect(parseTidyMerge('{"title":"A"}')).toBeUndefined();
    expect(parseTidyMerge("not json")).toBeUndefined();
    expect(parseTidyMerge(JSON.stringify({ title: "A", body: "x".repeat(1201) }))).toBeUndefined();
  });
});
