import { describe, expect, it } from "vitest";
import { runKnowledgeHygiene } from "./knowledge-hygiene.js";
import { digestSince, knowledgeReviewApi } from "./knowledge-review-api.js";
import { knowledgeWriteFixture } from "./knowledge-write-fixture.js";

const evidence = [{ kind: "task", ref: "t" }];
const lesson = {
  op: "create",
  scope: "project",
  kind: "lesson",
  title: "Cache the build",
  body: "Builds reuse the turbo cache.",
  evidence,
  reason: "Saw cache hits",
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
    api(method, params, `review:${++n}`) as Promise<Record<string, unknown>>;
  const proposals = async () =>
    (await call("proposal.list", { projectId: "a", state: "pending" })).items as {
      id: string;
      title: string;
    }[];
  return { k, call, proposals };
}

describe("knowledge review surfaces (12 section 6.4)", () => {
  it("rejects a proposal with a reason and auto-rejects the identical write later", async () => {
    const { k, call, proposals } = await review();
    try {
      expect((await k.write({ ...lesson, scope: "user", kind: "preference" })).result).toBe(
        "proposed",
      );
      const [proposal] = await proposals();
      await call("proposal.decide", {
        id: proposal?.id,
        decision: "reject",
        reason: "Not my preference",
      });
      expect(await proposals()).toEqual([]);
      expect(
        ((await call("proposal.list", { state: "rejected" })).items as unknown[])[0],
      ).toMatchObject({ state: "rejected", rejectionReason: "Not my preference" });
      expect(await k.write({ ...lesson, scope: "user", kind: "preference" })).toMatchObject({
        result: "rejected",
        why: expect.stringMatching(/^previously_rejected/),
      });
      expect(await proposals()).toEqual([]);
    } finally {
      k.f.close();
    }
  });

  it("accepts an edited and rescoped proposal as a human item", async () => {
    const { k, call, proposals } = await review();
    try {
      await k.write({ ...lesson, scope: "user", kind: "preference" });
      const [proposal] = await proposals();
      await call("proposal.decide", {
        id: proposal?.id,
        decision: "accept",
        title: "Cache builds",
        scope: { type: "project", id: "a" },
      });
      const items = (k.f.store.snapshot(["knowledge"]).knowledge ?? []).filter(
        (row) => row.title === "Cache builds",
      );
      expect(items).toMatchObject([
        { scope: { type: "project", id: "a" }, verification: "human", writer: { kind: "human" } },
      ]);
      await expect(
        call("proposal.decide", { id: proposal?.id, decision: "reject", reason: "x" }),
      ).rejects.toThrow("proposal_already_decided");
    } finally {
      k.f.close();
    }
  });

  it("lists agent writes for the digest, confirms one and reverts another", async () => {
    const { k, call } = await review();
    try {
      const first = await k.write(lesson);
      const second = await k.write({ ...lesson, title: "Pin pnpm", body: "Use pnpm 10." });
      const listed = (await call("knowledge.agentWrites", { projectId: "a", since: digestSince() }))
        .items as { id: string }[];
      expect(listed.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
      expect(
        (await call("knowledge.agentWrites", { projectId: "b", since: digestSince() })).items,
      ).toEqual([]);
      await call("knowledge.confirm", { id: first.id, expectedRevision: 1 });
      expect(k.f.store.record("knowledge", String(first.id))).toMatchObject({
        verification: "confirmed",
        revision: 2,
      });
      await expect(
        call("knowledge.revert", { id: second.id, expectedRevision: 1, confirmed: false }),
      ).rejects.toThrow("confirmation_required");
      await call("knowledge.revert", { id: second.id, expectedRevision: 1, confirmed: true });
      expect(k.f.store.record("knowledge", String(second.id))).toMatchObject({
        status: "archived",
        writer: { kind: "human" },
        revision: 2,
      });
      const after = (await call("knowledge.agentWrites", { projectId: "a" })).items as {
        id: string;
      }[];
      // A confirmation is a human revision, so the confirmed item leaves the agent writes list too.
      expect(after).toEqual([]);
    } finally {
      k.f.close();
    }
  });

  it("reverts an agent revision to the previous text as a new human revision", async () => {
    const { k, call } = await review();
    try {
      const applied = await k.write(lesson);
      await k.write({
        ...lesson,
        op: "revise",
        id: applied.id,
        expectedRevision: 1,
        body: "Builds skip the cache.",
      });
      await call("knowledge.revert", { id: applied.id, expectedRevision: 2, confirmed: true });
      expect(k.f.store.record("knowledge", String(applied.id))).toMatchObject({
        body: lesson.body,
        status: "active",
        revision: 3,
        writer: { kind: "human" },
      });
    } finally {
      k.f.close();
    }
  });
});

describe("knowledge hygiene", () => {
  // Agent writes are stamped with the wall clock, so hygiene runs are measured from now.
  const start = Date.now();
  const later = (days: number) => new Date(start + days * 24 * 60 * 60 * 1000);
  it("marks unread unverified items stale after 60 days and keeps read or human items", async () => {
    const { k } = await review();
    try {
      const unread = await k.write(lesson);
      const read = await k.write({ ...lesson, title: "Pin pnpm", body: "Use pnpm 10." });
      k.save({ id: "human", body: "Human item." });
      k.f.store.database
        .prepare(
          "INSERT INTO knowledge_reads_aux(id,task_id,session_id,query,item_ids,at) VALUES(?,?,?,?,?,?)",
        )
        .run("r", "t", "session", null, JSON.stringify([read.id]), later(30).toISOString());
      expect(runKnowledgeHygiene(k.f.store, () => {}, later(59))).toEqual({
        archived: [],
        stale: [],
      });
      expect(runKnowledgeHygiene(k.f.store, () => {}, later(61))).toEqual({
        archived: [],
        stale: [unread.id],
      });
      expect(k.f.store.record("knowledge", "human")).toMatchObject({ status: "active" });
      expect(k.f.store.record("knowledge", String(read.id))).toMatchObject({ status: "active" });
    } finally {
      k.f.close();
    }
  });

  it("archives agent task items 30 days after the task's thread is archived", async () => {
    const { k } = await review();
    try {
      const own = await k.write({ ...lesson, scope: "here" });
      const project = await k.write({ ...lesson, title: "Pin pnpm", body: "Use pnpm 10." });
      const threadId = String(k.f.store.record("task", "t")?.threadId);
      k.change({ type: "update", kind: "thread", id: threadId, changes: { archived: true } });
      expect(runKnowledgeHygiene(k.f.store, () => {}, new Date()).archived).toEqual([]);
      const result = runKnowledgeHygiene(k.f.store, () => {}, later(10_000));
      expect(result.archived).toEqual([own.id]);
      expect(k.f.store.record("knowledge", String(project.id))).toMatchObject({
        status: "stale",
      });
    } finally {
      k.f.close();
    }
  });
});
