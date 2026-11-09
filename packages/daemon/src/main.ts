import path from "node:path";
import { startDaemon } from "./api.js";
import { keychainProcess } from "./keychain-process.js";
import { productionRuntime } from "./production-runtime.js";
import { quickToolRuntime } from "./quick-chat/tool-runtime.js";
import { relayUrlPattern } from "./relay-link.js";
import { KeychainSecrets } from "./secrets.js";
import { deferredSetup } from "./setup-api.js";

const dataDir = process.env.ZOLTBOT_DATA_DIR ?? path.resolve(".cache/dev-daemon");
const secrets =
  process.platform === "darwin"
    ? new KeychainSecrets(
        keychainProcess({
          command:
            process.env.ZOLTBOT_KEYCHAIN_HELPER ??
            path.resolve(
              process.env.ZOLTBOT_REPO_ROOT ?? process.cwd(),
              ".cache/native/zoltbot-keychain",
            ),
          cwd: dataDir,
        }),
      )
    : undefined;

// The build's relay for phones; a relay address set in Settings takes precedence.
const relayUrl = process.env.ZOLTBOT_RELAY_URL;
const daemon = await startDaemon({
  dataDir,
  runtime: (context) => productionRuntime(context, dataDir),
  ...(secrets ? { secrets } : {}),
  // Quick Chat runs on the coding tools the person signed in to on this Mac.
  quickChat: { tools: quickToolRuntime(dataDir) },
  setup: (context) =>
    deferredSetup(async () => {
      const { createSetup } = await import("./setup.js");
      return createSetup({
        dataDir,
        onApply: context.applyImport,
        runtime: (definitionId) => {
          const state = context.snapshot();
          const profiles = new Set(
            state.agent?.filter((row) => row.definitionId === definitionId).map((row) => row.id),
          );
          const threads = new Set(
            state.thread?.filter((row) => profiles.has(row.agentId)).map((row) => row.id),
          );
          const session = state.session
            ?.filter((row) => threads.has(row.threadId))
            .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0];
          return session
            ? {
                state: session.state,
                capabilities: session.capabilities,
                providerVersion: session.providerVersion,
              }
            : { state: "not_connected" };
        },
        overrides: () => {
          const value = context
            .snapshot()
            .settings?.find((item) => item.key === "detect.overrides")?.value;
          return value && typeof value === "object" && !Array.isArray(value)
            ? (Object.fromEntries(
                Object.entries(value).filter(([, path]) => typeof path === "string"),
              ) as Record<string, string>)
            : {};
        },
        updateChecks: () =>
          context.snapshot().settings?.find((item) => item.key === "updates.check")?.value !==
          false,
        preference: () =>
          context.snapshot().settings?.find((item) => item.key === "providers.experimental")?.value,
      });
    }),
  ...(process.env.ZOLTBOT_UI_ORIGIN
    ? { origins: ["zoltbot://desktop", process.env.ZOLTBOT_UI_ORIGIN] }
    : {}),
  ...(relayUrl && relayUrlPattern.test(relayUrl) ? { relay: { defaultUrl: relayUrl } } : {}),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void daemon.close().then(() => {
      process.exitCode = 0;
    });
  });
