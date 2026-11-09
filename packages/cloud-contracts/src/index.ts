import { type Static, Type } from "@sinclair/typebox";
import { parse } from "@zoltbot/protocol";

export { type ArtifactManifest, ArtifactManifestSchema } from "@zoltbot/protocol";
export * from "./catalog.js";

/** Additive changes retain v1. A retirement window requires an owner decision. */
export const cloudContractVersion = 1;
const token = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
export const CredentialsSchema = Type.Object({
  accessToken: token,
  refreshToken: token,
  sessionId: Type.String(),
});
export type Credentials = Static<typeof CredentialsSchema>;
export function parseCredentials(value: unknown): Credentials {
  try {
    return parse(CredentialsSchema, value);
  } catch {
    throw new Error("invalid_account_credentials");
  }
}
export const NativeStartSchema = Type.Object({
  redirectUri: Type.String(),
  challenge: token,
  state: Type.String({ maxLength: 100 }),
});
export const NativeStartResultSchema = Type.Object({ intentId: Type.String(), url: Type.String() });
export const CloudErrorSchema = Type.Object({ error: Type.String() });
export const BrokerCatalogSchema = Type.Object({
  services: Type.Array(Type.String()),
  testServices: Type.Optional(Type.Array(Type.String())),
});
export const syntheticCredentials: Credentials = {
  accessToken: "a".repeat(43),
  refreshToken: "r".repeat(43),
  sessionId: "synthetic-session",
};

export * from "./wire.js";
