/** A sign-in for a coding tool. Credentials stay in the tool's own folder or the Keychain. */
export interface ModelAccountView {
  id: string;
  /** "Claude" for the tool's own sign-in, "Claude · Work" for an added one. */
  name: string;
  label: string;
  definitionId: string;
  providerName: string;
  isDefault: boolean;
  /** The tool can hold more than one sign-in. */
  canAddAccounts: boolean;
  login: "signed_in" | "signed_out" | "unknown";
  /** When the account's usage limit resets; null when it is not at a limit. */
  limitResetsAt: string | null;
  atLimit: boolean;
  /** Chats running on this account because of a switch. */
  inUse: number;
}

export interface BackupEntryView {
  accountId: string;
  model?: string;
}

export type BackupRole = "employee" | "manager" | "ceo";

export interface BackupOrdersView {
  employee: BackupEntryView[];
  /** Null: same as employees. */
  manager: BackupEntryView[] | null;
  /** Null: same as employees. */
  ceo: BackupEntryView[] | null;
}

/** A7: a free model the catalog lists, on its tool's own sign-in. */
export interface FreeModelView {
  accountId: string;
  model: string;
  name: string;
}

export interface ModelsOverview {
  accounts: ModelAccountView[];
  orders: BackupOrdersView;
  free: FreeModelView[];
}

/** A7: the free models an order doesn't list yet, as entries that fit in its 8 places. */
export function missingFreeModels(order: BackupEntryView[], free: FreeModelView[]) {
  return free
    .filter((item) => !order.some((e) => e.accountId === item.accountId && e.model === item.model))
    .slice(0, Math.max(0, 8 - order.length))
    .map((item) => ({ accountId: item.accountId, model: item.model }));
}

/** The command that signs a tool in to an account's own folder. */
export interface ModelSignIn {
  command: string;
  configDirectory: string;
  /** What to type inside the tool when the command only opens it. */
  slashCommand?: string;
}

export interface AddModelAccountInput {
  definitionId: string;
  label: string;
}

export interface SetBackupOrderInput {
  role: BackupRole;
  entries: BackupEntryView[] | null;
}

/** Shown in place of the usual prompt when work would move to another provider. */
export interface ModelSwitchDialog {
  from: string;
  to: string;
  provider: string;
  /** When the current account's limit resets, already formatted for display. */
  until: string | null;
  project: string | null;
}

export interface ModelsDesktopApi {
  read: () => Promise<ModelsOverview>;
  addAccount: (
    input: AddModelAccountInput,
  ) => Promise<{ account: ModelAccountView; signIn: ModelSignIn }>;
  signIn: (accountId: string) => Promise<ModelSignIn>;
  /** Asks the tool whether the account's folder is signed in. */
  check: (accountId: string) => Promise<ModelAccountView>;
  remove: (accountId: string) => Promise<void>;
  setOrder: (input: SetBackupOrderInput) => Promise<BackupOrdersView>;
  /** How many tasks one employee runs at once. */
  runningLimit: () => Promise<number>;
  setRunningLimit: (limit: number) => Promise<number>;
  /** A8: the model ids the owner starred, shared with the phone. */
  starred: () => Promise<string[]>;
  setStarred: (ids: string[]) => Promise<string[]>;
}

/** The bounds of the per-employee running-task limit; the daemon enforces the same. */
export const RUNNING_LIMIT = { min: 1, max: 20, default: 2 } as const;

export const MODEL_CHANNELS = {
  modelsRead: "models:read",
  modelsAddAccount: "models:add-account",
  modelsSignIn: "models:sign-in",
  modelsCheck: "models:check",
  modelsRemove: "models:remove",
  modelsSetOrder: "models:set-order",
  modelsRunningLimit: "models:running-limit",
  modelsSetRunningLimit: "models:set-running-limit",
  modelsStarred: "models:starred",
  modelsSetStarred: "models:set-starred",
} as const;
