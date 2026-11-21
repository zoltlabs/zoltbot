import { type Static, Type } from "@sinclair/typebox";
import { At, Id, object, values } from "./common.js";

// V1: the vault. Records hold no values: a password, setup key or secret lives in the Mac's
// keychain, and the agent picks an entry while the daemon types the value (I7).

export const VAULT_KINDS = ["login", "totp"] as const;
export const VaultKindSchema = values(VAULT_KINDS);
export type VaultKind = Static<typeof VaultKindSchema>;
export const MAX_VAULT_ENTRIES = 500;
export const MAX_VAULT_SITES = 10;
export const MAX_VAULT_VALUE = 4096;

const Label = Type.String({ minLength: 1, maxLength: 200 });
const Host = Type.String({ minLength: 1, maxLength: 253 });
/** "all", or the agents that may use the entry. */
export const VaultAgentsSchema = Type.Union([
  Type.Literal("all"),
  Type.Array(Id, { maxItems: 200 }),
]);
export type VaultAgents = Static<typeof VaultAgentsSchema>;

export const VaultEntrySchema = object({
  id: Id,
  kind: VaultKindSchema,
  label: Label,
  /** Hosts the entry may be filled on: each host itself, or its www. form. */
  sites: Type.Array(Host, { minItems: 1, maxItems: MAX_VAULT_SITES }),
  username: Type.Optional(Type.String({ maxLength: 500 })),
  agents: VaultAgentsSchema,
  /** Reserved for "Always allow": agents that may use the entry without asking. Not set yet. */
  trusted: Type.Optional(Type.Array(Id, { maxItems: 200 })),
  createdAt: At,
  lastUsedAt: Type.Optional(At),
});
export type VaultEntry = Static<typeof VaultEntrySchema>;

const Value = Type.String({ minLength: 1, maxLength: MAX_VAULT_VALUE });
const Sites = Type.Array(Host, { minItems: 1, maxItems: MAX_VAULT_SITES });

export const vaultMethods = {
  /** Never returns a value. `available` is false when this Mac has no keychain helper. */
  "vault.list": {
    params: object({}),
    result: object({
      entries: Type.Array(VaultEntrySchema, { maxItems: MAX_VAULT_ENTRIES }),
      available: Type.Boolean(),
    }),
  },
  /** `value` is the password (login) or the setup key or otpauth link (totp). */
  "vault.save": {
    params: object({
      kind: VaultKindSchema,
      label: Type.Optional(Label),
      sites: Sites,
      username: Type.Optional(Type.String({ maxLength: 500 })),
      agents: VaultAgentsSchema,
      value: Value,
    }),
    result: object({ entry: VaultEntrySchema }),
  },
  /** Omitted fields stay; a value replaces the stored one. */
  "vault.update": {
    params: object({
      id: Id,
      label: Type.Optional(Label),
      sites: Type.Optional(Sites),
      username: Type.Optional(Type.String({ maxLength: 500 })),
      agents: Type.Optional(VaultAgentsSchema),
      value: Type.Optional(Value),
    }),
    result: object({ entry: VaultEntrySchema }),
  },
  /** I13: removing needs the owner's confirmation. */
  "vault.remove": {
    params: object({ id: Id, confirmed: Type.Literal(true) }),
    result: object({ ok: Type.Literal(true) }),
  },
  /** Shows a stored value to the owner after the Mac's own Touch ID or password prompt. */
  "vault.reveal": {
    params: object({ id: Id }),
    result: object({ value: Type.String() }),
  },
};

export const vaultMacOnlyMethods = [
  "vault.list",
  "vault.save",
  "vault.update",
  "vault.remove",
  "vault.reveal",
] as const;

/**
 * The host of a site the owner typed: "https://GitHub.com/login" and "github.com" both give
 * "github.com". Undefined when it isn't a web host.
 */
export function vaultHost(input: string): string | undefined {
  const text = input.trim();
  if (!text || /\s/.test(text)) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || host.length > 253) return undefined;
    // A bare word like "github" is a typo, not a host; localhost and addresses are allowed.
    if (!host.includes(".") && host !== "localhost" && !host.startsWith("[")) return undefined;
    return host;
  } catch {
    return undefined;
  }
}

/**
 * Whether a page on `pageHost` may be filled from an entry listing `site`: the same host, or its
 * www. form. Other subdomains don't match, since many serve pages anyone can write.
 */
export function vaultSiteMatches(site: string, pageHost: string): boolean {
  const host = pageHost.toLowerCase().replace(/\.$/, "");
  return host === site || host === `www.${site}` || `www.${host}` === site;
}

export interface TotpSetup {
  secret: string;
  digits: 6 | 7 | 8;
  period: number;
  algorithm: "SHA1" | "SHA256" | "SHA512";
}

const BASE32 = /^[A-Z2-7]+=*$/;

/**
 * V6: reads a setup key ("JBSW Y3DP EHPK 3PXP") or an otpauth:// link. Undefined when it is
 * neither, so the form can say so before anything is saved.
 */
export function parseTotpSetup(input: string): TotpSetup | undefined {
  const text = input.trim();
  if (/^otpauth:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.host.toLowerCase() !== "totp") return undefined;
      const secret = (url.searchParams.get("secret") ?? "").replace(/[\s-]/g, "").toUpperCase();
      const digits = Number(url.searchParams.get("digits") ?? 6);
      const period = Number(url.searchParams.get("period") ?? 30);
      const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
      if (!BASE32.test(secret) || secret.replace(/=+$/, "").length < 16) return undefined;
      if (digits !== 6 && digits !== 7 && digits !== 8) return undefined;
      if (!Number.isInteger(period) || period < 10 || period > 300) return undefined;
      if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512")
        return undefined;
      return { secret, digits, period, algorithm };
    } catch {
      return undefined;
    }
  }
  const secret = text.replace(/[\s-]/g, "").toUpperCase();
  if (!BASE32.test(secret) || secret.replace(/=+$/, "").length < 16 || secret.length > 256)
    return undefined;
  return { secret, digits: 6, period: 30, algorithm: "SHA1" };
}

/** An otpauth link names its site in the issuer, so a pasted link can fill in the Site field. */
export function totpIssuer(input: string): string | undefined {
  if (!/^otpauth:\/\//i.test(input.trim())) return undefined;
  try {
    const url = new URL(input.trim());
    const issuer = url.searchParams.get("issuer") ?? decodeURIComponent(url.pathname.slice(1));
    return issuer.split(":")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
