// M6: an agent proposes saving or updating a skill after working something out. The owner saves
// or discards it in Needs review; nothing reaches the skills library until they save it.
import { randomUUID } from "node:crypto";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import {
  parse,
  parseEvent,
  SKILL_PROPOSAL_MAX_BYTES,
  type SkillProposal,
  SkillProposalSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { parseSkill, type SkillBundle, SkillsLibrary } from "../../skills/src/index.js";
import type { RuntimeContext } from "./api.js";

/** Pending proposals one agent may have waiting at once. */
export const SKILL_PROPOSAL_PENDING_CAP = 5;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Indirect tool: offered as a compact hint in chats the owner talks in. */
export const skillProposalToolDefinition = {
  name: "team_propose_skill",
  description:
    "Propose saving or updating a reusable skill. Propose only after finishing a task that took several attempts or that the owner corrected. body is the SKILL.md instructions; basedOn is the id of the library skill it updates. The owner reviews it before it is saved.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64 },
      description: { type: "string", maxLength: 1024 },
      body: { type: "string", minLength: 1, maxLength: SKILL_PROPOSAL_MAX_BYTES },
      basedOn: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["name", "body"],
    additionalProperties: false,
  },
};

export type SkillProposalResult =
  | { proposalId: string; state: "pending"; why: string }
  | { error: string; why: string };

const refused = (error: string, why: string) => ({ error, why });

/** The SKILL.md text of a bundle. */
export const skillText = (bundle: SkillBundle) =>
  bundle.files.find((file) => file.path === "SKILL.md")?.content ?? "";

export function skillProposalEvent(
  proposal: SkillProposal,
  created: boolean,
  context: { commandId: string; at: string },
  index = 0,
) {
  return parseEvent({
    eventId: `${context.commandId}:${index}`,
    aggregateType: "skillProposal",
    aggregateId: proposal.id,
    type: created ? "skillProposal.created" : "skillProposal.updated",
    occurredAt: context.at,
    payload: parse(SkillProposalSchema, proposal),
  });
}

/** The first line of the instructions, as a description when the agent gave none. */
function firstLine(body: string) {
  const line = body
    .split("\n")
    .map((row) => row.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return (line ?? "").slice(0, 200);
}

/** Wraps bare instructions in SKILL.md front matter; text that has its own is kept as is. */
export function skillMarkdown(name: string, description: string, body: string) {
  if (/^---\r?\n/.test(body)) return body;
  // A JSON string is a valid double-quoted YAML scalar.
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body.endsWith("\n") ? body : `${body}\n`}`;
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

export function skillProposals(context: RuntimeContext) {
  const { store } = context;
  const library = new SkillsLibrary(store.database);
  /** Shape and content checks; returns the proposal's fields or why it was refused. */
  function prepare(raw: unknown) {
    const args = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const allowed = Object.keys(skillProposalToolDefinition.inputSchema.properties);
    if (Object.keys(args).some((key) => !allowed.includes(key)))
      return refused("invalid_skill_proposal", "Pass only name, description, body and basedOn.");
    const name = text(args.name)?.trim() ?? "";
    if (!SLUG.test(name) || name.length > 64)
      return refused(
        "invalid_skill_name",
        "name must be a lowercase slug such as release-checklist (64 characters at most).",
      );
    const body = text(args.body) ?? "";
    if (!body.trim()) return refused("invalid_skill_proposal", "body is required.");
    if (Buffer.byteLength(body) > SKILL_PROPOSAL_MAX_BYTES)
      return refused("skill_too_large", "Keep body under 32 KB.");
    const basedOnId = text(args.basedOn)?.trim();
    let basedOn: { id: string; revision: number; bundle: SkillBundle } | undefined;
    if (basedOnId) {
      const entry = library.list().find((row) => row.id === basedOnId);
      if (!entry)
        return refused("skill_not_found", "basedOn must be the id of a skill in the library.");
      basedOn = {
        id: entry.id,
        revision: entry.current_revision,
        bundle: library.revision(entry.id, entry.current_revision).bundle,
      };
    } else {
      const existing = library.list().find((row) => row.name === name);
      if (existing)
        return refused(
          "skill_exists",
          `A skill named ${name} exists. To update it, pass basedOn: ${existing.id}.`,
        );
    }
    const description =
      text(args.description)?.trim() || basedOn?.bundle.description || firstLine(body) || name;
    const content = skillMarkdown(name, description.slice(0, 1024), body);
    let bundle: SkillBundle;
    try {
      // An update keeps the skill's other files, so SKILL.md may link to them.
      const others = (basedOn?.bundle.files ?? [])
        .filter((file) => file.path !== "SKILL.md")
        .map(({ path, content }) => ({ path, content }));
      bundle = parseSkill([...others, { path: "SKILL.md", content }]);
    } catch (error) {
      return refused("invalid_skill", error instanceof Error ? error.message : "Invalid SKILL.md.");
    }
    if (bundle.name !== name)
      return refused("invalid_skill_name", "The name in the front matter must match name.");
    if (basedOn && skillText(basedOn.bundle) === content)
      return refused("no_change", "This matches the saved skill; there is nothing to propose.");
    return { name, description: bundle.description, content, basedOn };
  }

  async function propose(call: ToolInvocation): Promise<SkillProposalResult> {
    const commandId = `skill-proposal:${call.idempotencyKey}`;
    // A retried call returns what it returned the first time, even after the owner decided.
    const earlier = store.receipt<SkillProposalResult>(commandId);
    if (earlier) return earlier.result;
    const prepared = prepare(call.arguments);
    if ("error" in prepared) return prepared;
    // Checked before anything is stored: a secret never reaches the database or event log.
    if (await context.privacy.containsSecret([prepared.name, prepared.content]))
      return refused("secret_detected", "The skill contains a secret; nothing was stored.");
    const check = await context.privacy.prepareData(prepared.content);
    const at = new Date().toISOString(),
      before = store.lastSeq();
    const receipt = store.dispatch(commandId, (state) => {
      check(state);
      const pending = (state.skillProposal ?? []).filter((row) => row.state === "pending");
      const basedOn = prepared.basedOn
        ? { id: prepared.basedOn.id, revision: prepared.basedOn.revision }
        : null;
      const same = pending.find(
        (row) =>
          row.content === prepared.content &&
          (row.basedOn as SkillProposal["basedOn"])?.id === basedOn?.id,
      );
      if (same)
        return {
          events: [],
          result: {
            proposalId: String(same.id),
            state: "pending",
            why: "The same proposal is already waiting for the owner.",
          } as SkillProposalResult,
        };
      if (
        pending.filter((row) => row.agentId === call.actor.agentId).length >=
        SKILL_PROPOSAL_PENDING_CAP
      )
        return {
          events: [],
          result: refused(
            "cap_reached",
            "Five of your skill proposals are already waiting for the owner. Wait for them to review those first.",
          ),
        };
      const proposal: SkillProposal = {
        id: randomUUID(),
        state: "pending",
        name: prepared.name,
        description: prepared.description,
        content: prepared.content,
        basedOn,
        agentId: call.actor.agentId,
        threadId: call.actor.threadId,
        sessionId: call.actor.sessionId,
        createdAt: at,
        updatedAt: at,
      };
      return {
        events: [skillProposalEvent(proposal, true, { commandId, at })],
        result: {
          proposalId: proposal.id,
          state: "pending",
          why: "The owner reviews it in Needs review; it is saved only if they approve it.",
        } as SkillProposalResult,
      };
    });
    context.publish(store.eventsSince(before));
    return receipt.result;
  }

  return {
    call: propose,
    /**
     * Any active agent chat that isn't a fork, task chats included: the hint is offered only in
     * owner chats, but a task agent that worked out a process may propose it too. The caller
     * checks the session is active; the per-agent cap bounds the review queue.
     */
    authorize(actor: ToolActor) {
      const thread = context.store.record("thread", actor.threadId);
      return !!thread && !thread.fork && thread.agentId === actor.agentId;
    },
  };
}

/** Pending proposals, newest first. */
export function pendingSkillProposals(store: Store): SkillProposal[] {
  return ((store.snapshot(["skillProposal"]).skillProposal ?? []) as SkillProposal[])
    .filter((row) => row.state === "pending")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Pending proposals with the SKILL.md text each one changes; null for a new skill. */
export function skillProposalList(store: Store, library: SkillsLibrary) {
  return pendingSkillProposals(store).map((proposal) => {
    let base: string | null = null;
    if (proposal.basedOn)
      try {
        base = skillText(library.revision(proposal.basedOn.id, proposal.basedOn.revision).bundle);
      } catch {
        base = null;
      }
    return { ...proposal, base };
  });
}

const CHANGED =
  "skill_changed: This skill changed after the agent proposed this. Discard it and ask the agent to propose again.";

/**
 * The owner's decision on a proposal. Saving goes through the library like skill.save: a new
 * revision of the skill it was based on, or a new skill. A skill that changed since is refused.
 */
export function decideSkillProposal(
  store: Store,
  library: SkillsLibrary,
  params: Record<string, unknown>,
) {
  const id = typeof params.id === "string" ? params.id : "";
  const decision = params.decision;
  if (!id || (decision !== "save" && decision !== "discard"))
    throw new Error("invalid_skill_params");
  const pending = () => {
    const row = store.record("skillProposal", id) as SkillProposal | undefined;
    if (!row) throw new Error("skill_proposal_not_found: This proposal is gone.");
    if (row.state !== "pending")
      throw new Error("skill_proposal_decided: This proposal was already handled.");
    return row;
  };
  const proposal = pending();
  const basedOn = proposal.basedOn;
  let bundle: SkillBundle | undefined;
  if (decision === "save") {
    if (basedOn) {
      const entry = library.list().find((row) => row.id === basedOn.id);
      if (!entry || entry.current_revision !== basedOn.revision) throw new Error(CHANGED);
      // Other files in the skill stay as they are; only SKILL.md changes.
      const files = library
        .revision(basedOn.id, basedOn.revision)
        .bundle.files.filter((file) => file.path !== "SKILL.md")
        .map(({ path, content }) => ({ path, content }));
      bundle = parseSkill([...files, { path: "SKILL.md", content: proposal.content }]);
    } else bundle = parseSkill([{ path: "SKILL.md", content: proposal.content }]);
  }
  const saved = bundle;
  return {
    bundle: saved,
    apply(): { state: "saved" | "discarded"; skillId?: string } {
      pending();
      if (!saved) return { state: "discarded" };
      try {
        if (basedOn) {
          library.save(basedOn.id, basedOn.revision, saved);
          return { state: "saved", skillId: basedOn.id };
        }
        return { state: "saved", skillId: library.add(saved).id };
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code.startsWith("skill_name_conflict"))
          throw new Error("skill_name_conflict: A skill with this name already exists.");
        if (code.startsWith("skill_revision_conflict") || code.startsWith("skill_removed"))
          throw new Error(CHANGED);
        throw error;
      }
    },
    events(result: unknown, context: { commandId: string; at: string }) {
      const outcome = result as { state: "saved" | "discarded"; skillId?: string };
      return [
        skillProposalEvent(
          {
            ...proposal,
            state: outcome.state,
            ...(outcome.skillId ? { skillId: outcome.skillId } : {}),
            updatedAt: context.at,
          },
          false,
          context,
        ),
      ];
    },
  };
}
