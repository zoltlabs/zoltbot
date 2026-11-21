// V1: the vault over IPC. Values go from the renderer to the daemon and on to the keychain; the
// list never carries one back.

export const VAULT_CHANNELS = {
  vaultList: "vault:list",
  vaultSave: "vault:save",
  vaultUpdate: "vault:update",
  vaultRemove: "vault:remove",
  vaultReveal: "vault:reveal",
  vaultAgents: "vault:agents",
  vaultProviders: "vault:providers",
  vaultProviderItems: "vault:provider-items",
  vaultProviderUnlock: "vault:provider-unlock",
  vaultProviderForget: "vault:provider-forget",
} as const;

export type VaultItemKind = "login" | "totp";

/** V3: password managers a login can come from. */
export type VaultProviderId = "1password" | "bitwarden" | "proton";

export interface VaultSource {
  provider: VaultProviderId;
  item: string;
}

export interface VaultProvider {
  id: VaultProviderId;
  name: string;
  state: "ready" | "locked" | "signed_out" | "missing" | "failed";
  /** For a manager unlocked with a session key: the program the key is given to. */
  path?: string;
}

/** A login in a password manager, by title and site only. */
export interface VaultProviderItem {
  id: string;
  title: string;
  username?: string;
  sites: string[];
}

export interface VaultItem {
  id: string;
  kind: VaultItemKind;
  label: string;
  sites: string[];
  username?: string;
  /** "all", or the agents that may use it. */
  agents: "all" | string[];
  createdAt: string;
  lastUsedAt?: string;
  /** V3: the password manager item it comes from. */
  source?: VaultSource;
}

export interface VaultList {
  items: VaultItem[];
  /** False when this Mac can't reach its keychain. */
  available: boolean;
}

export interface VaultSaveInput {
  kind: VaultItemKind;
  site: string;
  username?: string;
  agents: "all" | string[];
  /** The password, or the setup key or otpauth link. Absent for a login from a manager. */
  value?: string;
  source?: VaultSource;
}

export interface VaultUpdateInput {
  id: string;
  site?: string;
  username?: string;
  agents?: "all" | string[];
  /** Absent keeps the stored value. */
  value?: string;
}

export interface VaultDesktopApi {
  list: () => Promise<VaultList>;
  save: (input: VaultSaveInput) => Promise<VaultItem>;
  update: (input: VaultUpdateInput) => Promise<VaultItem>;
  remove: (id: string) => Promise<void>;
  /** The stored password or setup key, after the Mac's Touch ID or password prompt. */
  reveal: (id: string) => Promise<string>;
  /** Agents an entry can be given to, named by their chat. */
  agents: () => Promise<VaultAgent[]>;
  /** V3: password managers on this Mac and whether each can be read now. */
  providers: () => Promise<VaultProvider[]>;
  providerItems: (input: { provider: VaultProviderId; search?: string }) => Promise<
    VaultProviderItem[]
  >;
  /** Keeps a session key from the manager's own unlock command; returns the new state. */
  providerUnlock: (input: { provider: VaultProviderId; session: string }) => Promise<VaultProvider>;
  /** Drops the kept session key; returns the new state. */
  providerForget: (provider: VaultProviderId) => Promise<VaultProvider>;
}

export interface VaultAgent {
  id: string;
  name: string;
}
