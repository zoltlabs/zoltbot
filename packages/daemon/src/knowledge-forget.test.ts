// M2: dated facts and precise forget.
import { knowledgeHistory, upsertKnowledge } from "@zoltbot/knowledge";
import { describe, expect, it } from "vitest";
import { knowledgeReviewApi } from "./knowledge-review-api.js";
import { knowledgeWriteFixture } from "./knowledge-write-fixture.js";

const lesson = {
  op: "create",
  scope: "project",
  kind: "lesson",
  title: "Team leave",
  body: "Sam is on leave until 3 Dec. Builds reuse the turbo cache.",
  evidence: [{ kind: "task", ref: "t" }],
  reason: "Told in chat",
};
async function review() {
  const k = await knowledgeWriteFixture();
  const api = knowledgeReviewApi({
    store: k.f.store,
    publish: (events) => k.published.push(...events),
    checkPublic: async () => () => {},
  });
  let n = 0;
  const call = (method: string, params: Record<string, unknown>) =>
    api(method, params, `forget:${++n}`) as Promise<Record<string, unknown>>;
  return { k, call };
}

describe("forget one sentence", () => {
  it("removes only the quoted sentence as a new revision the history keeps", async () => {
    const { k, call } = await review();
    try {
      const { id } = await k.write(lesson);
      const result = await call("knowledge.forget", {
        id,
        quote: "Sam is on leave until 3 Dec.",
        expectedRevision: 1,
      });
      expect(result).toMatchObject({
        body: "Builds reuse the turbo cache.",
        revision: 2,
        status: "active",
        writer: { kind: "human" },
      });
      const history = knowledgeHistory(k.f.store, String(id));
      expect(history.map((row) => [row.revision, row.body])).toEqual([
        [2, "Builds reuse the turbo cache."],
        [1, lesson.body],
      ]);
      // The Memory page restores an older revision by saving its text again.
      const older = history[1];
      k.f.store.dispatch("restore", (state) =>
        upsertKnowledge(state, { ...older, revision: 2 }, 2, {
          commandId: "restore",
          at: new Date().toISOString(),
          actor: { kind: "human", id: "owner" },
        }),
      );
      expect(k.f.store.record("knowledge", String(id))).toMatchObject({
        body: lesson.body,
        revision: 3,
      });
      await expect(
        call("knowledge.forget", { id, quote: "Not in the entry", expectedRevision: 3 }),
      ).rejects.toThrow("knowledge_quote_not_found");
      await expect(
        call("knowledge.forget", { id, quote: "Builds", expectedRevision: 1 }),
      ).rejects.toThrow("knowledge_revision_conflict");
    } finally {
      k.f.close();
    }
  });

  it("archives an entry when its whole text is forgotten", async () => {
    const { k, call } = await review();
    try {
      const { id } = await k.write(lesson);
      expect(
        await call("knowledge.forget", { id, quote: lesson.body, expectedRevision: 1 }),
      ).toMatchObject({ body: "", status: "archived", revision: 2 });
    } finally {
      k.f.close();
    }
  });

  it("sends an agent's forget to the person with the exact text, never applying it", async () => {
    const { k, call } = await review();
    try {
      const { id } = await k.write(lesson);
      const result = await k.write({
        op: "forget",
        id,
        expectedRevision: 1,
        quote: "Sam is on leave until 3 Dec.",
        evidence: [],
        reason: "The user asked me to forget it",
      });
      expect(result).toMatchObject({
        result: "proposed",
        why: expect.stringMatching(/^forget_request/),
      });
      expect(k.f.store.record("knowledge", String(id))).toMatchObject({
        revision: 1,
        body: lesson.body,
      });
      const [proposal] = (await call("proposal.list", { projectId: "a", state: "pending" }))
        .items as Record<string, unknown>[];
      expect(proposal).toMatchObject({ op: "revise", forget: "Sam is on leave until 3 Dec." });
      await call("proposal.decide", { id: proposal?.id, decision: "accept" });
      expect(k.f.store.record("knowledge", String(id))).toMatchObject({
        body: "Builds reuse the turbo cache.",
        revision: 2,
      });
      await expect(
        k.write({
          op: "forget",
          id,
          expectedRevision: 2,
          quote: "Nope",
          evidence: [],
          reason: "x",
        }),
      ).rejects.toThrow("knowledge_quote_not_found");
    } finally {
      k.f.close();
    }
  });

  it("changes only the text when an agent's forget is accepted, and archives an emptied entry", async () => {
    const { k, call } = await review();
    try {
      const { id } = await k.write({ ...lesson, tags: ["team"] });
      await k.write({
        op: "forget",
        id,
        expectedRevision: 1,
        quote: lesson.body,
        kind: "constraint",
        validUntil: "2030-01-01",
        tags: [],
        evidence: [],
        reason: "Asked to forget",
      });
      const [proposal] = (await call("proposal.list", { projectId: "a", state: "pending" }))
        .items as Record<string, unknown>[];
      await call("proposal.decide", { id: proposal?.id, decision: "accept" });
      const item = k.f.store.record("knowledge", String(id));
      expect(item).toMatchObject({ kind: "lesson", tags: ["team"], status: "archived", body: "" });
      expect(item?.validUntil).toBeUndefined();
    } finally {
      k.f.close();
    }
  });

  it("keeps the end date an agent gives a fact", async () => {
    const { k } = await review();
    try {
      const { id } = await k.write({ ...lesson, validUntil: "2030-12-03T10:00:00Z" });
      expect(k.f.store.record("knowledge", String(id))).toMatchObject({
        validUntil: "2030-12-03T10:00:00.000Z",
      });
      for (const validUntil of ["soon", "Dec 3", "2001-01-01", "+010000-01-01T00:00:00Z"])
        await expect(k.write({ ...lesson, validUntil })).rejects.toThrow("invalid_knowledge_write");
    } finally {
      k.f.close();
    }
  });
});
