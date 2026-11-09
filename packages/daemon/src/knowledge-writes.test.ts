import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import { expect, it } from "vitest";
import { knowledgeWriteFixture } from "./knowledge-write-fixture.js";
import { knowledgeWrites } from "./knowledge-writes.js";
import { Logger, Redactor } from "./logging.js";
import {
  browserRuntimeToolDefinitions,
  indirectRuntimeToolDefinitions,
  runtimeToolDefinitions,
} from "./runtime-tools.js";

const evidence = [{ kind: "task", ref: "t" }];
const lesson = {
  op: "create",
  scope: "project",
  kind: "lesson",
  title: "Pin node versions",
  body: "Scripts use the version in .nvmrc.",
  evidence,
  reason: "CI failed on node 22",
};
/** Every byte the store keeps on disk, including the WAL. */
function storeBytes(dir: string) {
  return readdirSync(dir)
    .filter((name) => name.startsWith("store.db"))
    .map((name) => readFileSync(path.join(dir, name)).toString("latin1"))
    .join("");
}

it("rejects secrets before storage: nothing reaches the database, event log or receipts", async () => {
  const k = await knowledgeWriteFixture();
  try {
    const vault = "zb-planted-vault-value-8f2c";
    k.context.privacy.remember(vault);
    const pattern = "sk-plantedpatternsecret123456";
    for (const body of [`Deploy key is ${vault}.`, `Use ${pattern} for the API.`]) {
      const result = await k.write({ ...lesson, title: "Deploy", body });
      expect(result).toEqual({
        result: "rejected",
        why: expect.stringMatching(/^secret_detected/),
      });
    }
    const leaked = await k.write({ ...lesson, title: `Key ${vault}`, body: "Harmless body." });
    expect(leaked.result).toBe("rejected");
    k.f.store.database.pragma("wal_checkpoint(TRUNCATE)");
    const bytes = storeBytes(k.f.root);
    expect(bytes).not.toContain(vault);
    expect(bytes).not.toContain("plantedpatternsecret");
    expect(JSON.stringify(k.published)).not.toContain(vault);
    expect(JSON.stringify(k.f.store.eventsSince(0))).not.toContain(vault);
    const rows = k.f.store.database
      .prepare("SELECT outcome, reason, title, kind FROM knowledge_writes_aux")
      .all();
    expect(rows).toEqual(
      Array(3).fill({ outcome: "rejected", reason: "secret_detected", title: null, kind: null }),
    );
  } finally {
    k.f.close();
  }
});

it("applies a project lesson as unverified, then reports CAS conflicts and stays within 400 chars", async () => {
  const k = await knowledgeWriteFixture();
  try {
    const applied = await k.write(lesson);
    expect(applied).toMatchObject({ result: "applied", revision: 1 });
    expect(JSON.stringify(applied).length).toBeLessThanOrEqual(400);
    const item = k.f.store.record("knowledge", String(applied.id));
    expect(item).toMatchObject({
      scope: { type: "project", id: "a" },
      verification: "unverified",
      writer: { kind: "agent", id: "profile" },
      sources: [
        { kind: "task", ref: "t" },
        { kind: "task", ref: "t", label: "Agent write", sessionId: "session" },
      ],
    });
    const revised = await k.write({
      ...lesson,
      op: "revise",
      id: applied.id,
      expectedRevision: 1,
      body: "Scripts read .nvmrc; CI pins the same version.",
    });
    expect(revised).toMatchObject({ result: "applied", revision: 2 });
    expect(
      await k.write({ ...lesson, op: "revise", id: applied.id, expectedRevision: 1 }),
    ).toMatchObject({ result: "rejected", why: expect.stringMatching(/^stale_revision/) });
    const long = await k.write({ ...lesson, reason: "r".repeat(300), title: "t".repeat(200) });
    expect(JSON.stringify(long).length).toBeLessThanOrEqual(400);
  } finally {
    k.f.close();
  }
});

it("turns user scope writes and revisions of a person's item into proposals", async () => {
  const k = await knowledgeWriteFixture();
  try {
    k.save({ id: "units", body: "Use grams for meals." });
    const user = await k.write({ ...lesson, scope: "user", kind: "preference" });
    expect(user.result).toBe("proposed");
    const human = await k.write({
      ...lesson,
      op: "revise",
      id: "units",
      expectedRevision: 1,
      kind: "constraint",
      body: "Use ounces for meals.",
    });
    expect(human.result).toBe("proposed");
    expect(k.f.store.record("knowledge", "units")).toMatchObject({
      body: "Use grams for meals.",
      revision: 1,
    });
    const proposals = k.f.store.snapshot(["knowledgeProposal"]).knowledgeProposal ?? [];
    expect(proposals.map((row) => [row.why, row.state])).toEqual(
      expect.arrayContaining([
        ["user_scope", "pending"],
        ["protected_item", "pending"],
      ]),
    );
  } finally {
    k.f.close();
  }
});

it("lets the chief of staff apply project decisions and never grants the user scope", async () => {
  const k = await knowledgeWriteFixture();
  try {
    const decision = {
      ...lesson,
      kind: "decision",
      title: "Ship weekly",
      body: "Ship on Fridays.",
    };
    expect((await k.write(decision)).result).toBe("proposed");
    k.change({ type: "update", kind: "agent", id: "profile", changes: { kind: "chief_of_staff" } });
    expect(
      await k.write({ ...decision, title: "Review weekly", body: "Review on Mondays." }),
    ).toMatchObject({ result: "applied", why: expect.stringMatching(/^granted/) });
    expect((await k.write({ ...decision, scope: "user", title: "Me", body: "Mine." })).result).toBe(
      "proposed",
    );
  } finally {
    k.f.close();
  }
});

it("applies at a chat's own project node without a grant", async () => {
  const k = await knowledgeWriteFixture({ task: false });
  try {
    expect(
      await k.write({
        ...lesson,
        kind: "decision",
        evidence: [{ kind: "thread", ref: "thread" }],
      }),
    ).toMatchObject({ result: "applied", why: expect.stringMatching(/^own_node/) });
  } finally {
    k.f.close();
  }
});

it("routes learned entries through the same policy and caps them at five", async () => {
  const k = await knowledgeWriteFixture();
  try {
    const writes = knowledgeWrites(k.context);
    const entries = Array.from({ length: 6 }, (_, i) => ({
      kind: "lesson",
      title: `Lesson ${i} ${"abcdefghij"[i]}`,
      body: `Distinct body ${i} ${"klmnopqrst"[i]} about topic ${i * 7}.`,
      evidence,
    }));
    const results = await writes.learned(k.actor, [...entries, { kind: "lesson" }]);
    expect(results.map((row) => row.result)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
      "rejected",
      "rejected",
    ]);
    expect(
      k.f.store.database
        .prepare("SELECT count(*) AS n FROM knowledge_writes_aux WHERE source='learned'")
        .get(),
    ).toEqual({ n: 5 });
  } finally {
    k.f.close();
  }
});

it("authorizes writes like reads and keeps the indirect tool out of direct surfaces", async () => {
  const k = await knowledgeWriteFixture();
  try {
    expect(k.tools.authorize(k.actor, "team_write_knowledge", {})).toBe(true);
    expect(k.tools.authorize({ ...k.actor, threadId: "foreign" }, "team_write_knowledge", {})).toBe(
      false,
    );
    for (const surface of [runtimeToolDefinitions, browserRuntimeToolDefinitions])
      expect(surface.map((tool) => tool.name)).not.toContain("team_write_knowledge");
    expect(indirectRuntimeToolDefinitions.map((tool) => tool.name)).toEqual([
      "team_write_knowledge",
      "routine_draft",
    ]);
    for (const tool of indirectRuntimeToolDefinitions)
      expect(referenceTokenEstimate(JSON.stringify(tool))).toBeLessThanOrEqual(300);
    expect(
      referenceTokenEstimate(
        JSON.stringify([...runtimeToolDefinitions, ...indirectRuntimeToolDefinitions]),
      ),
    ).toBeLessThanOrEqual(1500); // Shared fixed tool budget; artifact/browser guidance is checked separately.
  } finally {
    k.f.close();
  }
});

it("keeps rejected secrets out of the session frame log", async () => {
  const k = await knowledgeWriteFixture();
  try {
    const vault = "zb-planted-frame-vault-77c1";
    k.context.privacy.remember(vault);
    const redactor = new Redactor();
    k.context.privacy.track(redactor);
    const file = path.join(k.f.root, "logs", "session.log.jsonl");
    const frames = new Logger(file, redactor);
    const shapes = ["ghp_abcdefghijklmnopqrstuvwxyz0123", "sk-plantedframesecret123456"];
    for (const body of [`Use ${vault}.`, ...shapes.map((shape) => `Token ${shape}.`)]) {
      // The provider frame carrying the tool call is logged before the policy rejects it.
      frames.write("info", "frame", {
        method: "tools/call",
        params: { name: "team_write_knowledge", arguments: { ...lesson, body } },
      });
      expect((await k.write({ ...lesson, body })).result).toBe("rejected");
    }
    const logged = readFileSync(file, "utf8");
    for (const value of [vault, ...shapes]) expect(logged).not.toContain(value);
  } finally {
    k.f.close();
  }
});
