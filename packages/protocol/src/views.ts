import { type Static, Type } from "@sinclair/typebox";
import { Id, OptionalText, object, values } from "./common.js";

export const ViewPermissionSchema = values(["read", "act", "approve"]);
export const ViewRecordSchema = object({
  id: Id,
  source: values(["builtin", "user"]),
  name: Type.String(),
  description: OptionalText,
  version: Type.String(),
  api: Type.Integer(),
  slots: Type.Array(Type.Literal("page")),
  bundleHash: Type.String(),
  entry: Type.String(),
  icon: OptionalText,
  requested: Type.Array(ViewPermissionSchema),
  granted: Type.Array(ViewPermissionSchema),
  overridesBuiltin: Type.Boolean(),
  enabled: Type.Boolean(),
  basedOn: Type.Optional(object({ id: Id, version: Type.String(), bundleHash: Type.String() })),
  builtinUpdate: Type.Optional(object({ version: Type.String(), bundleHash: Type.String() })),
  error: Type.Optional(object({ code: Id, message: Type.String(), path: OptionalText })),
  shortcuts: Type.Optional(
    Type.Array(object({ id: Id, keys: Type.String(), label: Type.String() })),
  ),
  changedAt: OptionalText,
});
export type ViewRecord = Static<typeof ViewRecordSchema>;
export const viewMethods = {
  "view.reload": { params: object({}), result: Type.Array(ViewRecordSchema) },
  "view.setEnabled": {
    params: object({ id: Id, enabled: Type.Boolean() }),
    result: ViewRecordSchema,
  },
};
export const viewMacOnlyMethods = Object.keys(viewMethods) as (keyof typeof viewMethods)[];
