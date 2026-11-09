import { Type } from "@sinclair/typebox";
import {
  ArtifactKeySchema,
  ArtifactKindSchema,
  ArtifactManifestSchema,
  At,
  object,
  parse,
} from "@zoltbot/protocol";
import { safeFile } from "./intake.js";
import { repositoryFileLimit } from "./repository-files.js";

const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const repositoryArtifactSchema = object({
  format: Type.Literal(1),
  key: ArtifactKeySchema,
  kind: ArtifactKindSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  currentManifestHash: hash,
  starredHashes: Type.Array(hash, { maxItems: 500 }),
  missingFiles: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 500 }),
});
export const repositoryVersionSchema = object({
  format: Type.Literal(1),
  number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  manifestHash: hash,
  manifest: ArtifactManifestSchema,
  note: Type.String({ maxLength: 1000 }),
  by: object({
    provider: Type.String({ maxLength: 200 }),
    profile: Type.String({ maxLength: 200 }),
  }),
  at: At,
});
export async function repositoryJson(root: string, relative: string) {
  const bytes = await safeFile(root, relative);
  if (bytes.length > repositoryFileLimit) throw Error("artifact_repository_metadata_limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
export const parseRepositoryArtifact = (value: unknown) => parse(repositoryArtifactSchema, value);
export const parseRepositoryVersion = (value: unknown) => parse(repositoryVersionSchema, value);
