import type { DomainState } from "@zoltbot/core";
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  type BackupEntry,
  type BackupOrders,
  type BackupRole,
  compareSessions,
  type ModelAccount,
  type Profile,
  parse,
} from "@zoltbot/protocol";

// Backup model state lives in daemon-only settings rows (see settings-api reserved keys).
export const accountKey = (id: string) => `models.account.${id}`;
export const loginKey = (id: string) => `models.login.${id}`;
export const limitKey = (id: string) => `models.limit.${id}`;
export const activeKey = (threadId: string) => `models.active.${threadId}`;
export const askedKey = (threadId: string) => `models.asked.${threadId}`;
export const exhaustedKey = (threadId: string) => `models.exhausted.${threadId}`;
export const ackKey = (scope: string) => `models.ack.${scope}`;
export const ordersKey = "models.orders";
/** A limit without a reset time is assumed to last this long. */
export const defaultLimitMs = 60 * 60_000;

/**
 * The variable each coding tool reads its sign-in folder from. Only these tools can hold more
 * than one sign-in; every other tool has just its own.
 */
const homeKeys: Record<string, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
export const accountHomeKey = (definition: Pick<AgentDefinition, "adapter">) =>
  homeKeys[definition.adapter];
export const defaultAccountId = (definitionId: string) => `default:${definitionId}`;

export interface StoredAccount {
  id: string;
  label: string;
  definitionId: string;
  configDirectory: string;
  createdAt: string;
}
export interface LimitRecord {
  resetsAt?: string;
  observedAt: string;
  sessionId: string;
}
/** Where a chat runs after its first switch. `home` is the agent's own definition and model. */
export interface ActiveRecord {
  accountId: string;
  model?: string;
  home: boolean;
  /** The switch started a fresh native session with the visible conversation copied in. */
  copied: boolean;
  /** The latest native session before the switch; a fresh one replaces it. */
  boundarySessionId?: string;
  /** The limit observation that caused the switch, so one limit switches once. */
  trigger?: string;
  /** The account the chat ran on before this switch. */
  fromAccountId?: string;
  at: string;
}
export interface OrderEntry extends BackupEntry {
  account: ModelAccount;
  definition: AgentDefinition;
}

export const setting = <T>(state: DomainState, key: string): T | undefined =>
  state.settings?.find((row) => row.key === key)?.value as T | undefined;

function definitions(state: DomainState) {
  return (state.agentDefinition ?? []).flatMap((row) => {
    try {
      const definition = parse(AgentDefinitionSchema, row);
      return definition.experimental ? [] : [definition];
    } catch {
      return [];
    }
  });
}
export function limitOf(state: DomainState, accountId: string, now: number) {
  const limit = setting<LimitRecord>(state, limitKey(accountId));
  if (!limit) return undefined;
  const until = limit.resetsAt
    ? Date.parse(limit.resetsAt)
    : Date.parse(limit.observedAt) + defaultLimitMs;
  return Number.isFinite(until) && until > now ? limit : undefined;
}
/** Every account: one default sign-in per coding tool in use, then the ones the owner added. */
export function listAccounts(state: DomainState, now = Date.now()): ModelAccount[] {
  const tools = definitions(state);
  const stored = (state.settings ?? [])
    .filter((row) => String(row.key).startsWith("models.account."))
    .map((row) => row.value as StoredAccount)
    .filter((row) => tools.some((d) => d.id === row.definitionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const active = (state.settings ?? [])
    .filter((row) => String(row.key).startsWith("models.active."))
    .map((row) => row.value as ActiveRecord);
  const view = (
    row: Omit<StoredAccount, "createdAt"> & { createdAt?: string },
    definition: AgentDefinition,
    isDefault: boolean,
  ): ModelAccount => {
    const limit = limitOf(state, row.id, now);
    const login = setting<{ state: ModelAccount["login"] }>(state, loginKey(row.id))?.state;
    return {
      id: row.id,
      label: row.label,
      definitionId: definition.id,
      provider: definition.adapter,
      configDirectory: row.configDirectory,
      isDefault,
      canAddAccounts: accountHomeKey(definition) !== undefined,
      login: login ?? "unknown",
      ...(limit
        ? {
            limit: {
              ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
              observedAt: limit.observedAt,
            },
          }
        : {}),
      inUse: active.filter((entry) => !entry.home && entry.accountId === row.id).length,
      ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    };
  };
  return [
    ...tools.map((definition) =>
      view(
        {
          id: defaultAccountId(definition.id),
          label: definition.displayName,
          definitionId: definition.id,
          configDirectory: definition.launch.env[accountHomeKey(definition) ?? ""] ?? "",
        },
        definition,
        true,
      ),
    ),
    ...stored.map((row) =>
      view(row, tools.find((d) => d.id === row.definitionId) as AgentDefinition, false),
    ),
  ];
}
/** How notes and asks name an account: the tool for a default sign-in, else tool and label. */
export function accountTitle(state: DomainState, accountId: string, now = Date.now()) {
  const account = listAccounts(state, now).find((row) => row.id === accountId);
  if (!account) return "The account";
  if (account.isDefault) return account.label;
  const tool = state.agentDefinition?.find((row) => row.id === account.definitionId);
  return `${String(tool?.displayName ?? account.provider)} · ${account.label}`;
}
export function readOrders(state: DomainState): BackupOrders {
  const value = setting<Partial<BackupOrders>>(state, ordersKey);
  return {
    employee: value?.employee ?? [],
    manager: value?.manager ?? null,
    ceo: value?.ceo ?? null,
    agents: value?.agents ?? {},
  };
}
/** CEO: the project's lead manager chat. Manager: a team's manager chat. Everyone else: employee. */
export function threadRole(state: DomainState, threadId: string): BackupRole {
  const thread = state.thread?.find((row) => row.id === threadId);
  if (thread?.kind !== "manager") return "employee";
  return (thread.node as { type?: string } | undefined)?.type === "subproject" ? "manager" : "ceo";
}
export function configuredOrder(state: DomainState, threadId: string): BackupEntry[] {
  const orders = readOrders(state);
  const role = threadRole(state, threadId);
  return orders.agents[threadId] ?? (role === "employee" ? null : orders[role]) ?? orders.employee;
}
/**
 * The order a chat switches through: its configured order, led by the agent's own sign-in and
 * model when the order does not list them. Entries whose account or tool is gone are dropped.
 */
export function effectiveOrder(
  state: DomainState,
  threadId: string,
  profile: Profile,
  now = Date.now(),
): OrderEntry[] {
  const accounts = listAccounts(state, now);
  const home = defaultAccountId(profile.definitionId);
  const resolve = (entry: BackupEntry): OrderEntry[] => {
    const account = accounts.find((row) => row.id === entry.accountId);
    const definition = definitions(state).find((row) => row.id === account?.definitionId);
    return account && definition ? [{ ...entry, account, definition }] : [];
  };
  const configured = configuredOrder(state, threadId).flatMap(resolve);
  const listed = configured.some(
    (entry) => entry.accountId === home && (!entry.model || entry.model === profile.model),
  );
  if (listed || !configured.length) return configured;
  return [
    ...resolve({ accountId: home, ...(profile.model ? { model: profile.model } : {}) }),
    ...configured,
  ];
}
/** The native session a fresh switch replaces: the latest one with a native id. */
export function latestNativeSession(state: DomainState, threadId: string) {
  return (state.session ?? [])
    .filter((row) => row.threadId === threadId && row.nativeId)
    .sort(compareSessions)[0];
}
/**
 * How the session manager launches a chat after a switch: the account's config folder, the
 * entry's model, and a fresh native session until one exists after the switch.
 */
export function backupLaunch(state: DomainState, threadId: string, profile: Profile) {
  const active = setting<ActiveRecord>(state, activeKey(threadId));
  const own = parse(
    AgentDefinitionSchema,
    state.agentDefinition?.find((row) => row.id === profile.definitionId),
  );
  if (!active) return { profile, definition: own, fresh: false };
  const account = active.home
    ? undefined
    : listAccounts(state).find((row) => row.id === active.accountId);
  const found = state.agentDefinition?.find((row) => row.id === account?.definitionId);
  const definition = found ? parse(AgentDefinitionSchema, found) : own;
  const key = accountHomeKey(definition);
  if (account && !account.isDefault && key)
    definition.launch.env = { ...definition.launch.env, [key]: account.configDirectory };
  const model = active.home || !account ? profile.model : active.model;
  const { model: _own, ...rest } = profile;
  return {
    profile: { ...rest, definitionId: definition.id, ...(model ? { model } : {}) },
    definition,
    fresh: active.copied && latestNativeSession(state, threadId)?.id === active.boundarySessionId,
  };
}
