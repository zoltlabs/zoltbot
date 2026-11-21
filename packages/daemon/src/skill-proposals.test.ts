import { referenceTokenEstimate } from "@zoltbot/adapters-sdk/tokens";
import type { SkillProposal } from "@zoltbot/protocol";
import { expect, it } from "vitest";
import { knowledgeWriteFixture } from "./knowledge-write-fixture.js";
import {
  chatSignalIndirectToolDefinitions,
  indirectRuntimeToolDefinitions,
  runtimeToolDefinitions,
} from "./runtime-tools.js";
import { SKILL_PROPOSAL_PENDING_CAP, skillMarkdown } from "./skill-proposals.js";
import { skillsApi } from "./skills-api.js";

const release = {
  name: "release-checklist",
  description: "Steps to cut a release",
  body: "# Release\n\n1. Run the tests.\n2. Tag the commit.\n",
};

async function fixture() {
  const k = await knowledgeWriteFixture();
  const api = skillsApi({ store: k.f.store, checkPublic: async () => {} });
  let keys = 0;
  const propose = async (args: Record<string, unknown>, key = `p${++keys}`) => {
    const tool = k.tools.tools.get("team_propose_skill");
    if (!tool) throw new Error("missing_tool");
    return (await tool({ actor: k.actor, arguments: args, idempotencyKey: key })) as {
      proposalId?: string;
      state?: string;
      error?: string;
      why: string;
    };
  };
  const list = async () =>
    ((await api("skill.proposal.list", {})) as { proposals: (SkillProposal & { base: string })[] })
      .proposals;
  const decide = (id: string, decision: "save" | "discard", commandId: string) =>
    api("skill.proposal.decide", { id, decision }, commandId);
  return { k, api, propose, list, decide };
}

it("proposes a new skill, lists it with no base text, and saves it as a library skill", async () => {
  const { k, api, propose, list, decide } = await fixture();
  try {
    const result = await propose(release);
    expect(result).toMatchObject({ state: "pending", why: expect.stringContaining("owner") });
    const [proposal] = await list();
    expect(proposal).toMatchObject({
      id: result.proposalId,
      name: "release-checklist",
      description: "Steps to cut a release",
      basedOn: null,
      base: null,
      agentId: "profile",
      threadId: "thread",
      sessionId: "session",
    });
    expect(proposal?.content).toBe(skillMarkdown(release.name, release.description, release.body));
    expect(k.published.some((event) => event.type === "skillProposal.created")).toBe(true);

    const saved = await decide(String(result.proposalId), "save", "decide-1");
    expect(saved).toMatchObject({ state: "saved", skillId: expect.any(String) });
    // A replayed command returns its receipt instead of saving twice.
    expect(await decide(String(result.proposalId), "save", "decide-1")).toEqual(saved);
    const skills = ((await api("skill.list", {})) as { skills: { name: string }[] }).skills;
    expect(skills.filter((skill) => skill.name === "release-checklist")).toHaveLength(1);
    expect(k.f.store.record("skillProposal", String(result.proposalId))).toMatchObject({
      state: "saved",
      skillId: (saved as { skillId: string }).skillId,
    });
    expect(await list()).toEqual([]);
    await expect(decide(String(result.proposalId), "discard", "decide-2")).rejects.toThrow(
      "already handled",
    );
  } finally {
    k.f.close();
  }
});

it("updates a library skill from the revision the agent read, and refuses when it changed", async () => {
  const { k, api, propose, list, decide } = await fixture();
  try {
    const original = "---\nname: report-format\ndescription: Weekly report\n---\nUse a table.\n";
    const added = (await api(
      "skill.save",
      {
        files: [
          { path: "SKILL.md", content: original },
          { path: "template.md", content: "| a | b |\n" },
        ],
      },
      "add-1",
    )) as { id: string };
    // Without basedOn, an existing name points the agent at the skill's id.
    expect(await propose({ name: "report-format", body: "Use a list." })).toMatchObject({
      error: "skill_exists",
      why: expect.stringContaining(added.id),
    });
    expect(
      await propose({ name: "report-format", basedOn: added.id, body: original }),
    ).toMatchObject({ error: "no_change" });
    const update = await propose({
      name: "report-format",
      basedOn: added.id,
      body: "Use [the template](template.md) with a totals row.\n",
    });
    const [proposal] = await list();
    expect(proposal).toMatchObject({
      basedOn: { id: added.id, revision: 1 },
      base: original,
      // The description carries over from the skill it updates.
      description: "Weekly report",
    });
    const saved = await decide(String(update.proposalId), "save", "decide-1");
    expect(saved).toMatchObject({ state: "saved", skillId: added.id });
    const current = (await api("skill.get", { id: added.id })) as {
      revision: { revision: number; bundle: { body: string; files: { path: string }[] } };
    };
    expect(current.revision.revision).toBe(2);
    expect(current.revision.bundle.body).toBe(
      "Use [the template](template.md) with a totals row.\n",
    );
    // Other files in the skill are kept.
    expect(current.revision.bundle.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "template.md",
    ]);

    const stale = await propose({ name: "report-format", basedOn: added.id, body: "Use bullets." });
    await api(
      "skill.save",
      {
        id: added.id,
        expectedRevision: 2,
        files: [{ path: "SKILL.md", content: original.replace("table", "chart") }],
      },
      "edit-1",
    );
    await expect(decide(String(stale.proposalId), "save", "decide-2")).rejects.toThrow(
      "This skill changed after the agent proposed this",
    );
    expect(k.f.store.record("skillProposal", String(stale.proposalId))?.state).toBe("pending");
    expect(await decide(String(stale.proposalId), "discard", "decide-3")).toEqual({
      state: "discarded",
    });
    expect(k.f.store.record("skillProposal", String(stale.proposalId))?.state).toBe("discarded");
  } finally {
    k.f.close();
  }
});

it("refuses bad names, oversized or invalid bodies, unknown skills and extra fields", async () => {
  const { k, propose, list } = await fixture();
  try {
    for (const [args, error] of [
      [{ ...release, name: "Release Checklist" }, "invalid_skill_name"],
      [{ ...release, body: "x".repeat(33 * 1024) }, "skill_too_large"],
      [{ ...release, body: "   " }, "invalid_skill_proposal"],
      [{ ...release, basedOn: "missing" }, "skill_not_found"],
      [{ ...release, model: "fast" }, "invalid_skill_proposal"],
      [{ ...release, body: "---\nname: other\ndescription: d\n---\nBody\n" }, "invalid_skill_name"],
      [
        { ...release, body: "---\nname: release-checklist\nmodel: x\n---\nBody\n" },
        "invalid_skill",
      ],
    ] as const)
      expect(await propose(args)).toMatchObject({ error });
    expect(await list()).toEqual([]);
  } finally {
    k.f.close();
  }
});

it("keeps secrets out of storage", async () => {
  const { k, propose, list } = await fixture();
  try {
    const vault = "zb-planted-skill-vault-41aa";
    k.context.privacy.remember(vault);
    for (const body of [`Deploy with ${vault}.`, "Use sk-plantedpatternsecret123456 to sign in."])
      expect(await propose({ ...release, body })).toMatchObject({ error: "secret_detected" });
    expect(await list()).toEqual([]);
    const log = JSON.stringify(k.f.store.eventsSince(0));
    expect(log).not.toContain(vault);
    expect(log).not.toContain("plantedpatternsecret");
  } finally {
    k.f.close();
  }
});

it("replays a call, reuses an identical pending proposal and caps pending proposals per agent", async () => {
  const { k, propose, list } = await fixture();
  try {
    const first = await propose(release, "same-key");
    expect(await propose({ ...release, body: "Changed." }, "same-key")).toEqual(first);
    expect((await propose(release)).proposalId).toBe(first.proposalId);
    for (let index = 1; index < SKILL_PROPOSAL_PENDING_CAP; index++)
      expect(await propose({ ...release, name: `skill-${index}` })).toMatchObject({
        state: "pending",
      });
    expect(await propose({ ...release, name: "one-too-many" })).toMatchObject({
      error: "cap_reached",
    });
    expect(await list()).toHaveLength(SKILL_PROPOSAL_PENDING_CAP);
  } finally {
    k.f.close();
  }
});

it("is offered as a compact hint in owner chats and refused in other threads", async () => {
  const { k } = await fixture();
  try {
    expect(k.tools.authorize(k.actor, "team_propose_skill", {})).toBe(true);
    expect(k.tools.authorize({ ...k.actor, threadId: "foreign" }, "team_propose_skill", {})).toBe(
      false,
    );
    for (const surface of [runtimeToolDefinitions, indirectRuntimeToolDefinitions])
      expect(surface.map((tool) => tool.name)).not.toContain("team_propose_skill");
    const hint = chatSignalIndirectToolDefinitions.find(
      (tool) => tool.name === "team_propose_skill",
    );
    expect(hint?.description).toMatch(/several attempts or the owner corrected/);
    expect(referenceTokenEstimate(JSON.stringify(hint))).toBeLessThanOrEqual(120);
  } finally {
    k.f.close();
  }
});
