import { type Static, Type } from "@sinclair/typebox";
import { Id, object, Text } from "./common.js";

const Version = Type.Integer({ minimum: 1 });
export const ConnectionSchema = object({
  id: Id,
  name: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$", examples: ["service"] }),
  projectId: Id,
  version: Version,
  transport: Type.Union([
    object({ kind: Type.Literal("https"), url: Text }),
    object({
      kind: Type.Literal("stdio"),
      command: Text,
      args: Type.Array(Text, { maxItems: 100 }),
    }),
  ]),
  credentialReference: Type.Optional(Text),
  posthog: Type.Optional(object({ projectId: Type.String({ pattern: "^[1-9][0-9]{0,19}$" }) })),
  schemaTokens: object({
    value: Type.Integer({ minimum: 0 }),
    source: Type.Union([Type.Literal("estimated"), Type.Literal("measured")]),
  }),
  revokedThroughVersion: Type.Optional(Version),
  executionApproved: Type.Optional(Type.Boolean()),
  source: Text,
  enabled: Type.Boolean(),
  profileIds: Type.Array(Id, { maxItems: 200 }),
  credentialStatus: Type.Union([
    Type.Literal("not_required"),
    Type.Literal("needs_sign_in"),
    Type.Literal("connected"),
  ]),
  health: Type.Union([
    Type.Literal("not_checked"),
    Type.Literal("healthy"),
    Type.Literal("unavailable"),
  ]),
  checkedAt: Type.Optional(Text),
});
export type Connection = Static<typeof ConnectionSchema>;
const ok = object({ ok: Type.Boolean() });
const authConfig = object({
  issuer: Text,
  clientId: Text,
  authorizationEndpoint: Text,
  tokenEndpoint: Text,
  scopes: Type.Array(Text),
  origins: Type.Array(Text),
});
export const connectionMethods = {
  "connection.catalog.list": {
    params: object({}),
    result: object({
      items: Type.Array(
        object({
          id: Text,
          name: Text,
          description: Text,
          origin: Text,
          documentation: Text,
          permissions: Text,
          availability: Type.Union([
            Type.Literal("available"),
            Type.Literal("registration_required"),
            Type.Literal("unavailable"),
          ]),
        }),
      ),
    }),
  },
  "connection.install": {
    params: object({
      serviceId: Type.Union(
        [
          "linear",
          "sentry",
          "github",
          "posthog",
          "gmail",
          "google_drive",
          "google_docs",
          "slack",
        ].map((id) => Type.Literal(id)),
      ),
      projectId: Id,
      organization: Type.Optional(Text),
      serviceProject: Type.Optional(Text),
    }),
    result: ConnectionSchema,
  },
  "connection.disable": { params: object({ id: Id, profileId: Id }), result: ok },
  "connection.test": { params: object({ id: Id }), result: ok },
  "connection.import": {
    params: object({ projectId: Id, confirmed: Type.Boolean() }),
    result: object({ imported: Type.Integer({ minimum: 0 }) }),
  },
  "connection.auth.start": {
    params: object({ id: Id, confirmed: Type.Boolean(), configuration: Type.Optional(authConfig) }),
    result: object({ id: Id, authorizationUrl: Text, destination: Text, scopes: Type.Array(Text) }),
  },
  "connection.auth.status": { params: object({ id: Id }), result: object({ state: Text }) },
  "connection.auth.cancel": { params: object({ id: Id }), result: object({ state: Text }) },
  "connection.list": {
    params: object({ projectId: Type.Optional(Id) }),
    result: object({ items: Type.Array(ConnectionSchema) }),
  },
  "connection.save": {
    params: object({
      value: ConnectionSchema,
      expectedVersion: Type.Integer({ minimum: 0 }),
      confirmed: Type.Boolean(),
      executionConfirmed: Type.Optional(Type.Boolean()),
    }),
    result: ConnectionSchema,
  },
  "connection.disconnect": {
    params: object({
      id: Id,
      confirmed: Type.Boolean(),
      stopSessions: Type.Boolean(),
      expectedVersion: Version,
      expectedSessionIds: Type.Array(Id),
    }),
    result: ok,
  },
  "connection.affectedSessions": {
    params: object({ id: Id }),
    result: object({ sessionIds: Type.Array(Id) }),
  },
};
