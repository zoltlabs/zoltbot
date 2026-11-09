import { Type } from "@sinclair/typebox";
import { Id, Json, object, ScopeSchema, Text } from "./common.js";

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
  "skill.import.preview": entry(object({ folder: Text })),
  "skill.import.apply": entry(object({ previewId: Id, hash: Id })),
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
] as const;
