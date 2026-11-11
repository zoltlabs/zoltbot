import { type Static, Type } from "@sinclair/typebox";
import { parse, values } from "@zoltbot/protocol";

export const ViewIdSchema = Type.String({ minLength: 2, maxLength: 40, pattern: "^[a-z0-9-]+$" });
export const HashSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
// SemVer 2.0: numeric prerelease identifiers cannot have leading zeroes.
const numeric = "(?:0|[1-9][0-9]*)";
const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
export const ViewVersionSchema = Type.String({
  pattern: `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
});
export const PermissionSchema = values(["read", "act", "approve"]);
export type Permission = Static<typeof PermissionSchema>;
export const ViewPathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern:
    "^(?!_host(?:/|$))(?!.*[\\\\:#?%\\u0000-\\u001f\\u007f])(?!/)(?!.*(?:^|/)(?:\\.\\.?|)(?:/|$)).+$",
});
export const BasedOnSchema = Type.Object({
  id: ViewIdSchema,
  version: ViewVersionSchema,
  bundleHash: HashSchema,
});
export const ShortcutSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 40, pattern: "^[a-z0-9-]+$" }),
  keys: Type.String({ minLength: 1, maxLength: 80 }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
});
export const ViewManifestSchema = Type.Object({
  manifest: Type.Literal(1),
  id: ViewIdSchema,
  name: Type.String({ minLength: 1, maxLength: 40 }),
  description: Type.Optional(Type.String({ maxLength: 200 })),
  version: ViewVersionSchema,
  api: Type.Literal(1),
  entry: Type.Intersect([ViewPathSchema, Type.String({ pattern: "\\.html$" })]),
  icon: Type.Optional(Type.Intersect([ViewPathSchema, Type.String({ pattern: "\\.(svg|png)$" })])),
  slots: Type.Tuple([Type.Literal("page")]),
  permissions: Type.Array(PermissionSchema, {
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    contains: Type.Literal("read"),
  }),
  shortcuts: Type.Optional(Type.Array(ShortcutSchema, { maxItems: 30 })),
  author: Type.Optional(Type.String({ maxLength: 80 })),
  license: Type.Optional(Type.String({ maxLength: 80 })),
  basedOn: Type.Optional(BasedOnSchema),
});
export type ViewManifest = Static<typeof ViewManifestSchema>;
/** Ignore unknown fields while keeping their original file bytes in the bundle hash. */
export function parseViewManifest(value: unknown, folder: string): ViewManifest {
  const manifest = parse(ViewManifestSchema, value);
  if (manifest.id !== folder) throw Error("view_id_must_match_folder");
  const ids = manifest.shortcuts?.map((shortcut) => shortcut.id) ?? [];
  if (new Set(ids).size !== ids.length) throw Error("view_duplicate_shortcut");
  const result = Object.fromEntries(
    Object.keys(ViewManifestSchema.properties)
      .filter((key) => Object.hasOwn(manifest, key))
      .map((key) => [key, (manifest as Record<string, unknown>)[key]]),
  ) as ViewManifest;
  if (manifest.basedOn)
    result.basedOn = {
      id: manifest.basedOn.id,
      version: manifest.basedOn.version,
      bundleHash: manifest.basedOn.bundleHash,
    };
  if (manifest.shortcuts)
    result.shortcuts = manifest.shortcuts.map(({ id, keys, label }) => ({ id, keys, label }));
  return result;
}
