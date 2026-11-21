// R2: the Mac's side of the cloud relay for routine web addresses. The cloud keeps only a hash of
// each address, so this Mac keeps the address itself in the keychain, for Copy and Send test.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { HookCloud, HookRequest } from "../webhook-event-source.js";
import type { AccountSessionOptions } from "./index.js";

type Request = (path: string, method?: string, payload?: string) => Promise<unknown>;

export interface HookAddresses extends Required<HookCloud> {
  /**
   * The address for `resource`, made if there is none. `elsewhere` means the address exists but
   * was made on another Mac, so only rotating can show it here.
   */
  address(
    resource: string,
    options?: { rotate?: boolean },
  ): Promise<{ state: "ready"; url: string } | { state: "elsewhere" }>;
  /** Posts a small test request to the address, as any caller would. */
  test(resource: string): Promise<void>;
}

type Kept = Record<string, { account: string; url: string }>;
type Secrets = AccountSessionOptions["secrets"] & { exists?(reference: string): Promise<boolean> };

/**
 * Addresses by hook id, in one keychain item named by a reference file. A keychain that can't be
 * read stops the write, so a locked keychain never erases the addresses kept for other routines.
 */
function addressStore(secrets: Secrets, referenceFile: string, origin: string) {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action, action);
    queue = next.catch(() => {});
    return next;
  };
  async function reference() {
    try {
      return (await readFile(referenceFile, "utf8")).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  /** The kept addresses, and the item's reference when there is one to replace. */
  async function read(): Promise<{ kept: Kept; saved?: string }> {
    const saved = await reference();
    if (!saved) return { kept: {} };
    let value: unknown;
    try {
      value = await secrets.read(saved);
    } catch (error) {
      // The item was deleted outside the app: start a new one rather than stay stuck.
      if (secrets.exists && !(await secrets.exists(saved))) {
        await rm(referenceFile, { force: true });
        return { kept: {} };
      }
      throw error;
    }
    const item = value as {
      kind?: unknown;
      version?: unknown;
      origin?: unknown;
      addresses?: unknown;
    };
    // Labelled, so this item and the account's credentials can never be taken for each other.
    if (
      !item ||
      item.kind !== "hook-addresses" ||
      item.version !== 1 ||
      item.origin !== origin ||
      !item.addresses ||
      typeof item.addresses !== "object"
    )
      throw new Error("keychain_unavailable");
    const kept: Kept = {};
    for (const [id, entry] of Object.entries(item.addresses as Record<string, unknown>)) {
      const row = entry as { account?: unknown; url?: unknown };
      if (row && typeof row.account === "string" && typeof row.url === "string")
        kept[id] = { account: row.account, url: row.url };
    }
    return { kept, saved };
  }
  async function write(saved: string | undefined, addresses: Kept) {
    const value = { kind: "hook-addresses", version: 1, origin, addresses };
    if (saved) return secrets.replace(saved, value);
    const next = await secrets.put(value);
    const temporary = `${referenceFile}.tmp`;
    try {
      await writeFile(temporary, next.reference, { mode: 0o600 });
      await rename(temporary, referenceFile);
    } catch (error) {
      await secrets.remove(next.reference);
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return {
    get: (account: string, hookId: string) =>
      serialized(async () => {
        const entry = (await read()).kept[hookId];
        return entry?.account === account ? entry.url : undefined;
      }),
    /** Keeps `url`, forgetting this account's addresses for hooks that no longer exist. */
    set: (account: string, hookId: string, url: string, live: string[]) =>
      serialized(async () => {
        const { kept, saved } = await read();
        const next = Object.fromEntries(
          Object.entries(kept).filter(
            ([id, entry]) => id !== hookId && (entry.account !== account || live.includes(id)),
          ),
        );
        await write(saved, { ...next, [hookId]: { account, url } });
      }),
  };
}

export function accountHookCloud(options: {
  request: Request;
  origin: string;
  secrets: Secrets;
  referenceFile: string;
  fetch?: typeof fetch;
}): HookAddresses {
  const send = options.fetch ?? fetch;
  const store = addressStore(options.secrets, options.referenceFile, options.origin);
  const list = async () =>
    (await options.request("/api/cloud/hooks", "GET")) as {
      account: { id: string };
      hooks: { id: string; resource: string }[];
    };
  /** Only addresses on the account's own origin are kept or called. */
  const ours = (url: string) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === options.origin && /^\/h\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname);
    } catch {
      return false;
    }
  };
  async function create(resource: string, account: string, live: string[]) {
    const made = (await options.request(
      "/api/cloud/hooks",
      "POST",
      JSON.stringify({ resource }),
    )) as { id: string; url: string };
    if (!ours(made.url)) throw new Error("account_service_unavailable");
    await store.set(account, made.id, made.url, live);
    return made.url;
  }
  async function address(resource: string, choice: { rotate?: boolean } = {}) {
    const current = await list();
    const hook = current.hooks.find((entry) => entry.resource === resource);
    const live = current.hooks.map((entry) => entry.id);
    if (hook && !choice.rotate) {
      const url = await store.get(current.account.id, hook.id);
      if (!url || !ours(url)) return { state: "elsewhere" as const };
      return { state: "ready" as const, url };
    }
    return { state: "ready" as const, url: await create(resource, current.account.id, live) };
  }
  return {
    async hook(resource) {
      const current = await list();
      const hook = current.hooks.find((entry) => entry.resource === resource);
      return hook
        ? { accountId: current.account.id, accountLabel: "your Zoltbot account", hookId: hook.id }
        : undefined;
    },
    async requests(hookId, since) {
      const result = (await options.request(
        `/api/cloud/hooks/${hookId}/requests?since=${encodeURIComponent(since)}`,
        "GET",
      )) as { requests: HookRequest[] };
      return result.requests;
    },
    address,
    async test(resource) {
      const found = await address(resource);
      if (found.state !== "ready") throw new Error("webhook_address_elsewhere");
      const response = await send(found.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true, sentAt: new Date().toISOString() }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      }).catch(() => undefined);
      await response?.body?.cancel().catch(() => {});
      if (response?.status !== 202)
        throw new Error(
          response?.status === 429 ? "webhook_test_rate_limited" : "webhook_test_failed",
        );
    },
  };
}

/** Each address this client shows is registered as a secret first, so logs never carry it. */
export function redactedHookCloud(
  hooks: HookAddresses,
  register: (url: string) => void,
): HookAddresses {
  return {
    ...hooks,
    async address(resource, choice) {
      const found = await hooks.address(resource, choice);
      if (found.state === "ready") register(found.url);
      return found;
    },
  };
}
