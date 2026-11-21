// V3: logins kept in a password manager. Zoltbot stores which item a vault entry points to and
// asks the manager's own CLI for the login when an agent signs in, so the manager's unlock prompt
// applies and the value is never stored. CLI output stays in memory: it is parsed for the fields
// named below and never logged or returned whole.
import { createHash } from "node:crypto";
import { access, constants, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  type CommandRunner,
  knownDirectories,
  LoginPath,
  processEnvironment,
  runCommand,
} from "@zoltbot/detect";
import {
  MAX_VAULT_PROVIDER_ITEMS,
  MAX_VAULT_SITES,
  VAULT_PROVIDERS,
  type VaultProvider,
  type VaultProviderId,
  type VaultProviderItem,
  vaultHost,
} from "@zoltbot/protocol";

type State = VaultProvider["state"];
export interface ProviderLogin {
  username?: string;
  password: string;
}

/** How the daemon reaches one manager's CLI. */
export interface ProviderCli {
  run(
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ code: number | null; stdout: string }>;
}

interface Adapter {
  name: string;
  binary: string;
  state(cli: ProviderCli, env: Record<string, string>): Promise<State>;
  items(cli: ProviderCli, env: Record<string, string>): Promise<VaultProviderItem[]>;
  read(cli: ProviderCli, env: Record<string, string>, item: string): Promise<ProviderLogin>;
  /** The environment variable that carries a session key, for managers that use one. */
  sessionVariable?: string;
}

function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("provider_output_invalid");
  }
}

const text = (value: unknown, max = 500) =>
  typeof value === "string" && value.length <= max ? value : undefined;

function hosts(urls: unknown[]): string[] {
  const found = urls.flatMap((url) => (typeof url === "string" ? (vaultHost(url) ?? []) : []));
  return [...new Set(found)].slice(0, MAX_VAULT_SITES);
}

function item(id: unknown, title: unknown, username: unknown, urls: unknown[]) {
  const itemId = text(id, 200);
  if (!itemId || !validItem(itemId)) return [];
  const name = text(title, 200) ?? "";
  const user = text(username);
  return [{ id: itemId, title: name, ...(user ? { username: user } : {}), sites: hosts(urls) }];
}

/** An item id from the manager's own list; nothing a CLI could read as an option. */
export function validItem(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_:=-]{0,199}$/.test(id);
}

function ok(result: { code: number | null; stdout: string }) {
  if (result.code !== 0) throw new Error("provider_failed");
  return result.stdout;
}

const onePassword: Adapter = {
  name: "1Password",
  binary: "op",
  async state(cli) {
    return (await cli.run(["whoami", "--format", "json"])).code === 0 ? "ready" : "signed_out";
  },
  async items(cli) {
    const list = json(
      ok(await cli.run(["item", "list", "--categories", "Login", "--format", "json"])),
    );
    if (!Array.isArray(list)) throw new Error("provider_output_invalid");
    return list.flatMap((row: Record<string, unknown>) =>
      item(
        row.id,
        row.title,
        row.additional_information,
        Array.isArray(row.urls) ? row.urls.map((url: { href?: unknown }) => url?.href) : [],
      ),
    );
  },
  async read(cli, _env, id) {
    const fields = json(
      ok(
        await cli.run([
          "item",
          "get",
          id,
          "--fields",
          "label=username,label=password",
          "--reveal",
          "--format",
          "json",
        ]),
      ),
    );
    const list = (Array.isArray(fields) ? fields : [fields]) as Record<string, unknown>[];
    const value = (label: string) =>
      text(list.find((field) => field?.label === label)?.value, 4096);
    const password = value("password");
    if (!password) throw new Error("provider_item_has_no_password");
    const username = value("username");
    return { password, ...(username ? { username } : {}) };
  },
};

const bitwarden: Adapter = {
  name: "Bitwarden",
  binary: "bw",
  sessionVariable: "BW_SESSION",
  async state(cli, env) {
    const result = await cli.run(["status"], env);
    const status = result.code === 0 ? (json(result.stdout) as { status?: unknown }).status : "";
    return status === "unlocked" ? "ready" : status === "locked" ? "locked" : "signed_out";
  },
  async items(cli, env) {
    // `bw list` returns whole items, passwords included; only the fields below are kept.
    const list = json(ok(await cli.run(["list", "items"], env)));
    if (!Array.isArray(list)) throw new Error("provider_output_invalid");
    return list.flatMap((row: Record<string, unknown>) => {
      const login = row.login as { username?: unknown; uris?: { uri?: unknown }[] } | undefined;
      if (row.type !== 1 || !login) return [];
      return item(
        row.id,
        row.name,
        login.username,
        Array.isArray(login.uris) ? login.uris.map((uri) => uri?.uri) : [],
      );
    });
  },
  async read(cli, env, id) {
    const row = json(ok(await cli.run(["get", "item", id], env))) as {
      login?: { username?: unknown; password?: unknown };
    };
    const password = text(row.login?.password, 4096);
    if (!password) throw new Error("provider_item_has_no_password");
    const username = text(row.login?.username);
    return { password, ...(username ? { username } : {}) };
  },
};

// Proton Pass's CLI is new; these commands follow its documentation and haven't been run
// against the real tool yet.
const proton: Adapter = {
  name: "Proton Pass",
  binary: "pass-cli",
  async state(cli) {
    return (await cli.run(["info"])).code === 0 ? "ready" : "signed_out";
  },
  async items(cli) {
    const list = json(ok(await cli.run(["item", "list", "--output", "json"])));
    const rows = Array.isArray(list) ? list : ((list as { items?: unknown[] })?.items ?? []);
    return rows.flatMap((row) => {
      const value = row as Record<string, unknown>;
      const content = (value.content ?? value) as Record<string, unknown>;
      return item(
        value.id ?? value.item_id,
        value.title ?? content.title,
        content.username ?? content.email,
        Array.isArray(content.urls) ? content.urls : [],
      );
    });
  },
  async read(cli, _env, id) {
    const row = json(ok(await cli.run(["item", "view", "--item-id", id, "--output", "json"])));
    const value = row as Record<string, unknown>;
    const content = (value.content ?? value) as Record<string, unknown>;
    const password = text(content.password, 4096);
    if (!password) throw new Error("provider_item_has_no_password");
    const username = text(content.username ?? content.email);
    return { password, ...(username ? { username } : {}) };
  },
};

const ADAPTERS: Record<VaultProviderId, Adapter> = {
  "1password": onePassword,
  bitwarden,
  proton,
};

/** How the daemon finds and runs the managers' CLIs; tests pass fakes. */
export interface ProviderHost {
  /** The CLI's absolute path, or undefined when this Mac doesn't have it. */
  find(binary: string): Promise<string | undefined>;
  /**
   * Which program a path is now: its real path and a hash of its contents. A session key goes
   * only to the program it was given for, so a CLI swapped in later doesn't receive it.
   */
  identify(file: string): Promise<string>;
  run: CommandRunner;
}

/** A session key and the program it was given for. */
export interface ProviderSession {
  value: string;
  binary: string;
}

/** Finds CLIs in Homebrew's folders first, then on the login shell's PATH and the usual folders. */
export function defaultFinder(cwd: string) {
  const loginPath = new LoginPath();
  return async (binary: string) => {
    const home = homedir();
    const directories = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      ...(await loginPath.resolve(process.env.SHELL ?? "/bin/zsh", {
        cwd,
        inherited: { HOME: home, PATH: process.env.PATH ?? "" },
      })),
      ...(await knownDirectories(home)),
    ];
    for (const directory of directories) {
      const file = path.join(directory, binary);
      if (
        await access(file, constants.X_OK).then(
          () => true,
          () => false,
        )
      )
        return file;
    }
    return undefined;
  };
}

export async function identifyProgram(file: string): Promise<string> {
  const real = await realpath(file);
  const hash = createHash("sha256")
    .update(await readFile(real))
    .digest("hex");
  return `${real}:${hash}`;
}

export function vaultProviders(
  host: ProviderHost & {
    cwd: string;
    /** The session key the owner gave for a manager that needs one (Bitwarden). */
    session(provider: VaultProviderId): Promise<ProviderSession | undefined>;
  },
) {
  /** `offered` is a key being checked before it is kept. */
  async function cli(provider: VaultProviderId, offered?: string) {
    const adapter = ADAPTERS[provider];
    const file = await host.find(adapter.binary);
    if (!file) return undefined;
    let env: Record<string, string> = {};
    let binary: string | undefined;
    if (adapter.sessionVariable) {
      binary = await host.identify(file).catch(() => undefined);
      const stored = offered === undefined ? await host.session(provider) : undefined;
      const value = offered ?? (stored && stored.binary === binary ? stored.value : undefined);
      if (value && binary) env = { [adapter.sessionVariable]: value };
    }
    // With a key, run the program that was checked rather than a link that could be repointed.
    const program =
      binary && Object.keys(env).length ? binary.slice(0, binary.lastIndexOf(":")) : file;
    const runner: ProviderCli = {
      async run(args, extra = {}) {
        const result = await host.run(program, args, {
          cwd: host.cwd,
          env: processEnvironment(process.env, { ...env, ...extra }),
          timeoutMs: 60_000,
          maxOutputBytes: 8 * 1024 * 1024,
        });
        return { code: result.failure ? null : result.code, stdout: result.stdout };
      },
    };
    return { adapter, runner, env, file, binary };
  }
  /** The manager's state, and for one with a session key the program a key would be kept for. */
  async function check(provider: VaultProviderId, offered?: string) {
    const adapter = ADAPTERS[provider];
    const found = await cli(provider, offered);
    const value: State = found
      ? await adapter.state(found.runner, found.env).catch(() => "failed" as const)
      : "missing";
    const state: VaultProvider = {
      id: provider,
      name: adapter.name,
      state: value,
      ...(found && adapter.sessionVariable ? { path: found.file } : {}),
    };
    return { state, binary: found?.binary };
  }
  const state = async (provider: VaultProviderId) => (await check(provider)).state;
  return {
    list: () => Promise.all(VAULT_PROVIDERS.map(state)),
    state,
    check,
    async items(provider: VaultProviderId, search = "") {
      const found = await cli(provider);
      if (!found) throw new Error("provider_missing");
      const query = search.trim().toLowerCase();
      return (await found.adapter.items(found.runner, found.env))
        .filter(
          (row) =>
            !query ||
            row.title.toLowerCase().includes(query) ||
            row.sites.some((site) => site.includes(query)),
        )
        .slice(0, MAX_VAULT_PROVIDER_ITEMS);
    },
    async read(provider: VaultProviderId, itemId: string): Promise<ProviderLogin> {
      if (!validItem(itemId)) throw new Error("provider_item_invalid");
      const found = await cli(provider);
      if (!found) throw new Error("provider_missing");
      return found.adapter.read(found.runner, found.env, itemId);
    },
  };
}

export type VaultProviders = ReturnType<typeof vaultProviders>;

/** The real CLIs on this Mac. */
export function defaultProviderHost(cwd: string): ProviderHost {
  return { find: defaultFinder(cwd), identify: identifyProgram, run: runCommand };
}
