import { Type } from "@sinclair/typebox";
import { ArtifactManifestSchema } from "@zoltbot/protocol";

// Schemas describe the wire, not authorization, quota or endpoint trust decisions.
// Unknown response fields remain allowed for additive v1 server updates.
const opaque = Type.String({ minLength: 1 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const id = Type.String({ pattern: "^[a-f0-9-]{36}$" });
export const NativeRedeemSchema = Type.Object({
  code: opaque,
  verifier: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  deviceName: Type.String({ maxLength: 100 }),
});
export const RefreshSchema = Type.Object({ refreshToken: opaque });
export const ArtifactReserveSchema = Type.Object({
  confirm: Type.Literal(true),
  orgId: id,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 100 }),
  manifest: ArtifactManifestSchema,
});
export const ArtifactReservationSchema = Type.Object({
  id,
  state: Type.Union([Type.Literal("pending"), Type.Literal("ready")]),
  uploaded: Type.Array(digest),
});
export const ArtifactListSchema = Type.Object({
  artifacts: Type.Array(Type.Object({ id, title: Type.String() })),
});
export const ArtifactVisibilitySchema = Type.Union([
  Type.Literal("private"),
  Type.Literal("public"),
]);
export const ArtifactViewSchema = Type.Object({
  title: Type.String(),
  visibility: ArtifactVisibilitySchema,
  manifestHash: digest,
});
export const ArtifactVisibilityRequestSchema = Type.Object({
  confirm: Type.Literal(true),
  visibility: ArtifactVisibilitySchema,
  manifestHash: digest,
});
export const ArtifactVisibilityResultSchema = Type.Object({
  visibility: ArtifactVisibilitySchema,
  shareUrl: Type.String(),
});
export const BrokerAuthorizationSchema = Type.Object({
  client_id: opaque,
  response_type: Type.Literal("code"),
  code_challenge_method: Type.Literal("S256"),
  code_challenge: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
  redirect_uri: opaque,
  resource: opaque,
  scope: opaque,
  state: Type.String({ minLength: 1, maxLength: 200 }),
});
export const BrokerTokenSchema = Type.Object({
  access_token: opaque,
  token_type: opaque,
  expires_in: Type.Optional(Type.Number()),
  refresh_token: Type.Optional(opaque),
  scope: Type.Optional(Type.String()),
});
