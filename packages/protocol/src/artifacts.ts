import { type Static, Type } from "@sinclair/typebox";
import { At, Id, Json, OptionalText, object, Text, values } from "./common.js";
export const OutputModeSchema = values([
  "auto",
  "answer",
  "document",
  "page",
  "design",
  "chart",
  "code_change",
]);
export type OutputMode = Static<typeof OutputModeSchema>;
export const ArtifactTargetSchema = object({ artifactId: Id, versionId: Id });
export type ArtifactTarget = Static<typeof ArtifactTargetSchema>;
export const outputModes: { value: OutputMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "answer", label: "Answer in chat" },
  { value: "document", label: "Document" },
  { value: "page", label: "Page" },
  { value: "design", label: "Design" },
  { value: "chart", label: "Chart" },
  { value: "code_change", label: "Code change" },
];
export const ArtifactKindSchema = values([
  "document",
  "page",
  "design",
  "diagram",
  "chart",
  "image",
  "file",
  "code_change",
  "external",
]);
export const ArtifactKeySchema = Type.String({
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  maxLength: 64,
});
export const ArtifactFileSchema = object({
  path: Type.String({ maxLength: 512 }),
  hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  bytes: Type.Integer({ minimum: 0, maximum: 26214400 }),
  mime: Type.String({ maxLength: 80, pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$" }),
});
export const ArtifactScreenSchema = object({
  id: ArtifactKeySchema,
  title: Type.String({ maxLength: 200 }),
  path: Text,
  width: Type.Integer({ minimum: 1, maximum: 4096 }),
  height: Type.Integer({ minimum: 1, maximum: 4096 }),
});
export const ArtifactManifestSchema = object({
  version: Type.Literal(1),
  entry: Text,
  files: Type.Array(ArtifactFileSchema, { minItems: 1, maxItems: 500 }),
  screens: Type.Array(ArtifactScreenSchema, { maxItems: 100 }),
  kit: Type.Optional(Type.Literal("v1")),
});
export const ArtifactSchema = object({
  id: Id,
  projectId: Type.Optional(Id),
  threadId: Id,
  taskId: Type.Optional(Id),
  key: ArtifactKeySchema,
  kind: ArtifactKindSchema,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  currentVersionId: Id,
  starredVersionIds: Type.Array(Id),
  provider: Text,
  profileId: Id,
  state: values(["active", "archived", "invalid_repository"]),
  externalUrl: OptionalText,
  repositoryRoot: OptionalText,
  repositoryState: values([
    "local",
    "pending",
    "written",
    "held_secret",
    "partial",
    "from_repository",
  ]),
  createdAt: At,
  updatedAt: At,
});
export const ArtifactVersionSchema = object({
  id: Id,
  artifactId: Id,
  number: Type.Integer({ minimum: 1 }),
  manifestHash: Text,
  totalBytes: Type.Integer({ minimum: 0, maximum: 104857600 }),
  fileCount: Type.Integer({ minimum: 0, maximum: 500 }),
  repositoryRoot: OptionalText,
  producedBy: Type.Optional(object({ provider: Text, profile: Text })),
  sessionId: Id,
  turnId: Id,
  baseVersionId: Type.Optional(Id),
  taskId: Type.Optional(Id),
  taskRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  note: Type.String({ maxLength: 1000 }),
  auto: Type.Boolean(),
  held: Type.Boolean(),
  metadataOnly: Type.Boolean(),
  thumbnailState: values(["pending", "ready", "failed"]),
  thumbnails: Type.Record(Text, Text),
  reviewState: values(["unreviewed", "accepted", "changes_requested", "rejected"]),
  reviewer: OptionalText,
  createdAt: At,
});
export const ArtifactAnchorSchema = object({
  screen: OptionalText,
  selector: Type.Optional(Type.String({ maxLength: 500 })),
  quote: Type.Optional(Type.String({ maxLength: 300 })),
  prefix: OptionalText,
  suffix: OptionalText,
  x: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  y: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  width: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  height: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
export const ArtifactCommentSchema = object({
  id: Id,
  artifactId: Id,
  versionId: Id,
  anchor: ArtifactAnchorSchema,
  body: Type.String({ minLength: 1, maxLength: 2000 }),
  author: Text,
  state: values(["draft", "open", "addressed", "resolved", "detached"]),
  addressedByVersionId: Type.Optional(Id),
  sentIn: OptionalText,
  createdAt: At,
  updatedAt: At,
});
export type Artifact = Static<typeof ArtifactSchema>;
export type ArtifactVersion = Static<typeof ArtifactVersionSchema>;
export type ArtifactManifest = Static<typeof ArtifactManifestSchema>;
export type ArtifactComment = Static<typeof ArtifactCommentSchema>;
export interface ArtifactBinding {
  version: 1;
  id: string;
  stagingRoot: string;
  repositoryRoot?: string;
  toolsVersion: 2;
  sourceRead?: 1;
  guidanceText: string;
  guidanceHash: string;
}
const id = object({ id: Id });
export const artifactMethods = {
  "artifact.designer": { params: object({ projectId: Type.Optional(Id) }), result: Json },
  "artifact.repository.index": { params: object({ projectId: Id }), result: Json },
  "artifact.list": {
    params: object({
      projectId: Type.Optional(Id),
      threadId: Type.Optional(Id),
      query: OptionalText,
      kind: Type.Optional(ArtifactKindSchema),
      cursor: OptionalText,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    result: Json,
  },
  "artifact.phonePreview": { params: object({ id: Id, versionId: Id }), result: Json },
  "artifact.get": { params: object({ id: Id, versionId: Type.Optional(Id) }), result: Json },
  "artifact.versions": { params: id, result: Json },
  "artifact.add_to_repository": {
    params: object({ id: Id, versionId: Id, allowHeld: Type.Boolean() }),
    result: Json,
  },
  "artifact.archive": { params: id, result: Json },
};

export interface HostToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}
