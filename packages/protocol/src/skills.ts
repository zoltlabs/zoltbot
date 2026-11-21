import { type Static, Type } from "@sinclair/typebox";
import { At, Id, Json, object, ScopeSchema, Text, values } from "./common.js";

const revision = Type.Integer({ minimum: 1 });
const files = Type.Array(
  object({ path: Type.String({ maxLength: 512 }), content: Type.String({ maxLength: 256000 }) }),
  { minItems: 1, maxItems: 100 },
);
const entry = (params: ReturnType<typeof object>, result = Json) => ({ params, result });
export const skillMethods = {
  "skill.list": entry(object({})),
  "skill.get": entry(object({ id: Id, revision: Type.Optional(revision) })),
  "skill.detect": entry(object({})),
  /** M5: `source` reads a GitHub link instead of a local folder. */
  "skill.import.preview": entry(
    object({
      folder: Type.Optional(Text),
      source: Type.Optional(
        object({ kind: Type.Literal("github"), url: Type.String({ maxLength: 2000 }) }),
      ),
    }),
  ),
  /** M5: previews a skill from a GitHub link. Unlike a folder preview, a paired phone may call it. */
  "skill.import.link": entry(object({ url: Type.String({ minLength: 1, maxLength: 2000 }) })),
  "skill.import.apply": entry(object({ previewId: Id, hash: Id })),
  /** M5: installs a preview from `skill.import.link`; it refuses folder previews. */
  "skill.import.link.apply": entry(object({ previewId: Id, hash: Id })),
  "skill.save": entry(
    object({ id: Type.Optional(Id), expectedRevision: Type.Optional(revision), files }),
  ),
  "skill.remove": entry(object({ id: Id, confirmed: Type.Boolean() })),
  "skill.access": entry(
    object({
      profileId: Id,
      scopeId: Id,
      skillId: Id,
      revision,
      enabled: Type.Boolean(),
      confirmed: Type.Boolean(),
    }),
  ),
  "skill.assignments": entry(object({ profileId: Id, scopeId: Id })),
  "skill.update.preview": entry(object({ id: Id })),
  "skill.update.apply": entry(
    object({
      id: Id,
      expectedRevision: revision,
      previewId: Id,
      hash: Id,
      choice: Type.Union([Type.Literal("keep"), Type.Literal("replace"), Type.Literal("copy")]),
      files: Type.Optional(files),
    }),
  ),
  /** M6: skills agents proposed, with the SKILL.md text each one changes. */
  "skill.proposal.list": entry(object({})),
  /** M6: saves a proposal through the library, or discards it. */
  "skill.proposal.decide": entry(
    object({ id: Id, decision: Type.Union([Type.Literal("save"), Type.Literal("discard")]) }),
  ),
  "skill.context": entry(
    object({
      taskId: Id,
      preview: Type.Optional(Type.Boolean()),
      profileId: Type.Optional(Id),
      scope: Type.Optional(ScopeSchema),
    }),
  ),
};
export const skillMacOnlyMethods = [
  "skill.detect",
  "skill.import.preview",
  "skill.import.apply",
  "skill.update.preview",
  "skill.update.apply",
  "skill.proposal.list",
  "skill.proposal.decide",
] as const;

/** M6: the most an agent's proposed SKILL.md instructions may hold, in bytes. */
export const SKILL_PROPOSAL_MAX_BYTES = 32 * 1024;
/** M6: a skill an agent proposed to save or update, waiting for the owner. */
export const SkillProposalSchema = object({
  id: Id,
  state: values(["pending", "saved", "discarded"]),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ maxLength: 1024 }),
  /** The whole SKILL.md, front matter included. */
  content: Type.String({ minLength: 1, maxLength: 40000 }),
  /** The library skill and the revision the agent read; null for a new skill. */
  basedOn: Type.Union([object({ id: Id, revision }), Type.Null()]),
  agentId: Id,
  threadId: Id,
  sessionId: Id,
  /** The library skill the proposal saved to. */
  skillId: Type.Optional(Id),
  createdAt: At,
  updatedAt: At,
});
export type SkillProposal = Static<typeof SkillProposalSchema>;
