// I8: writes as zoltbot[bot]. When the owner turned on Post as Zoltbot and the GitHub App is
// installed on a repository, pull requests, comments and reviews there are sent with a
// short-lived installation token. Anything else, or any failure, uses the owner's gh login as
// before.
import type { GitHubTransport } from "./transport.js";

export type InstallationAnswer =
  | { installed: true; installationId: number; token: string; expiresAt: string }
  | { installed: false };

/** Tokens are reused until five minutes before they expire. */
const MARGIN_MS = 5 * 60 * 1000;
/** A repository without the app is asked about again after ten minutes. */
const NOT_INSTALLED_MS = 10 * 60 * 1000;
/** After a failed exchange, writes go out as the owner for a minute before asking again. */
const FAILED_MS = 60 * 1000;

export function installationTokens(options: {
  request(repo: string, installationId?: number): Promise<InstallationAnswer>;
  now?: () => number;
  onError?(code: string): void;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { token?: string; installationId?: number; until: number }>();
  return {
    async token(repo: string): Promise<string | undefined> {
      const key = repo.toLowerCase();
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.token;
      try {
        const answer = await options.request(repo, hit?.installationId);
        if (!answer.installed) {
          cache.set(key, { until: now() + NOT_INSTALLED_MS });
          return undefined;
        }
        cache.set(key, {
          token: answer.token,
          installationId: answer.installationId,
          until: Date.parse(answer.expiresAt) - MARGIN_MS,
        });
        if (cache.size > 200) cache.delete(cache.keys().next().value as string);
        return answer.token;
      } catch {
        // The owner's login still works; the bot is a preference, not a requirement.
        cache.set(key, {
          ...(hit?.installationId ? { installationId: hit.installationId } : {}),
          until: now() + FAILED_MS,
        });
        options.onError?.("github_bot_token_unavailable");
        return undefined;
      }
    },
    /** GitHub refused a cached token (app removed, permission changed): ask again next time. */
    forget(repo: string) {
      const hit = cache.get(repo.toLowerCase());
      if (hit)
        cache.set(repo.toLowerCase(), {
          ...(hit.installationId ? { installationId: hit.installationId } : {}),
          until: 0,
        });
    },
  };
}
export type InstallationTokens = ReturnType<typeof installationTokens>;

/** Writes that come from the bot: opening pull requests. */
const BOT_WRITE = /^\/repos\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pulls$/;
/** GitHub definitely refused the request, so nothing was created and the owner can retry it. */
const REFUSED = new Set(["github_auth_required", "github_access_denied"]);

export function botTransport(
  options: {
    tokens: Pick<InstallationTokens, "token"> & Partial<Pick<InstallationTokens, "forget">>;
    enabled(): boolean;
  },
  transport: (...args: [...Parameters<GitHubTransport>, token?: string]) => Promise<unknown>,
): GitHubTransport {
  return async (endpoint, method = "GET", body, signal) => {
    const repo = method === "POST" ? BOT_WRITE.exec(endpoint)?.[1] : undefined;
    const token = repo && options.enabled() ? await options.tokens.token(repo) : undefined;
    if (!token) return transport(endpoint, method, body, signal);
    try {
      return await transport(endpoint, method, body, signal, token);
    } catch (error) {
      // A timeout may have created the pull request already; only a clear refusal is retried.
      if (!repo || !(error instanceof Error) || !REFUSED.has(error.message)) throw error;
      options.tokens.forget?.(repo);
      return transport(endpoint, method, body, signal);
    }
  };
}
