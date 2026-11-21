// V1: the vault over IPC. Values go from the renderer to the daemon and on to the keychain; the
// list never carries one back.

export const VAULT_CHANNELS = {
  vaultList: "vault:list",
  vaultSave: "vault:save",
  vaultUpdate: "vault:update",
  vaultRemove: "vault:remove",
  vaultReveal: "vault:reveal",
  vaultAgents: "vault:agents",
} as const;

export type VaultItemKind = "login" | "totp";

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
  /** The password, or the setup key or otpauth link. */
  value: string;
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
}

export interface VaultAgent {
  id: string;
  name: string;
}
