import { randomUUID } from "node:crypto";
import { startDaemon } from "@zoltbot/daemon";

// The devices e2e (D124) needs a Mac identity; an in-memory vault stands in for the Keychain.
const dataDir = process.env.ZOLTBOT_DATA_DIR;
if (!dataDir) throw new Error("Test data directory required");
const memory = new Map<string, unknown>();
const daemon = await startDaemon({
  dataDir,
  secrets: {
    async put(value) {
      const reference = `keychain:zoltbot:${randomUUID()}`;
      memory.set(reference, structuredClone(value));
      return { reference };
    },
    async read(reference) {
      if (!memory.has(reference)) throw new Error("keychain_unavailable");
      return structuredClone(memory.get(reference));
    },
  },
  relay: { retry: { baseMs: 100, maxMs: 1000 } },
  ...(process.env.ZOLTBOT_UI_ORIGIN
    ? { origins: ["zoltbot://desktop", process.env.ZOLTBOT_UI_ORIGIN] }
    : {}),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void daemon.close().then(() => {
      process.exitCode = 0;
    });
  });
