// I8: pull requests from zoltbot[bot]. Installation tokens come from the cloud through the
// signed-in account's broker; they stay in this process and reach gh only as GH_TOKEN.
import {
  githubInstallationTokenPath,
  installationTokenRequest,
  parseInstallationToken,
} from "@zoltbot/cloud-contracts/github-app";
import { GITHUB_BOT_SETTING } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import {
  botTransport,
  type InstallationTokens,
  installationTokens,
} from "../../../github/src/app-token.js";
import type { GitHubTransport } from "../../../github/src/transport.js";
import { accountBrokerClient } from "../account-session/broker-client.js";

export type CloudRequest = (path: string, method: string, payload?: string) => Promise<unknown>;

export function githubBotTokens(cloudRequest: CloudRequest, onError?: (code: string) => void) {
  return installationTokens({
    request: async (repo, installationId) =>
      parseInstallationToken(
        await cloudRequest(
          githubInstallationTokenPath,
          "POST",
          JSON.stringify(installationTokenRequest(repo, installationId)),
        ),
      ),
    ...(onError ? { onError } : {}),
  });
}

/** The owner's choice, read on every write so turning it off applies at once. */
export const postAsBot = (store: Store) =>
  store.record("settings", GITHUB_BOT_SETTING)?.value === true;

export function githubBotTransport(
  store: Store,
  tokens: InstallationTokens | undefined,
  transport: Parameters<typeof botTransport>[1],
): GitHubTransport {
  if (!tokens) return (endpoint, method, body, signal) => transport(endpoint, method, body, signal);
  return botTransport({ tokens, enabled: () => postAsBot(store) }, transport);
}

/** Tokens asked for through the daemon's own account broker socket. */
export function githubAccountTokens(
  socketPath: string,
  origin: string,
  logger: { write(level: "warn", code: string): void },
) {
  // A client per request, so signing out and back in never leaves the bot on an old session.
  return githubBotTokens(
    (path, method, payload) =>
      accountBrokerClient({ socketPath, origin }).cloudRequest(path, method, payload),
    (code) => logger.write("warn", code),
  );
}
