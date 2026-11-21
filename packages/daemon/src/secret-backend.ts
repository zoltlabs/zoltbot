// D10: where saved logins live on each system. The Mac keeps them in its keychain; a Linux server,
// which has none, keeps them sealed in files (file-secrets.ts) apart from the data folder.
import path from "node:path";
import { fileSecretTransport } from "./file-secrets.js";
import { keychainProcess } from "./keychain-process.js";
import type { KeychainTransport } from "./secrets.js";

export function secretBackend(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  cwd: string;
  /** V1: reveal waits for the owner at the Touch ID or password prompt. */
  timeoutMs?: number;
}): KeychainTransport | undefined {
  const { env } = input;
  // A folder named explicitly wins, so the file store can also be tried on a Mac.
  if (env.ZOLTBOT_SECRETS_DIR || input.platform === "linux")
    return fileSecretTransport({
      dir: path.resolve(env.ZOLTBOT_SECRETS_DIR ?? `${input.dataDir}-secrets`),
      ...(env.ZOLTBOT_SECRET_KEY_FILE
        ? { keyFile: path.resolve(env.ZOLTBOT_SECRET_KEY_FILE) }
        : {}),
    });
  if (input.platform === "darwin")
    return keychainProcess({
      command:
        env.ZOLTBOT_KEYCHAIN_HELPER ??
        path.resolve(env.ZOLTBOT_REPO_ROOT ?? input.cwd, ".cache/native/zoltbot-keychain"),
      cwd: input.dataDir,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  return undefined;
}
