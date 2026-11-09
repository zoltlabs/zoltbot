import { readFileSync } from "node:fs";
import { FirestoreRegistry, metadataProject } from "./firestore.js";
import { ApnsPush, DisabledPush, type PushSender } from "./push.js";
import { MemoryRegistry, type Registry } from "./registry.js";
import { createRelay, type Logger, type LogLevel } from "./server.js";

// Entry point for Cloud Run. Settings come from the environment; see README.md.

const env = process.env;
const levels: LogLevel[] = ["debug", "info", "warn", "error"];
const minimum = levels.indexOf((env.RELAY_LOG_LEVEL as LogLevel) ?? "info");

/** One JSON line per event, which Cloud Logging reads as structured logs. */
const log: Logger = (level, event, fields) => {
  if (levels.indexOf(level) < minimum) return;
  const severity = level === "warn" ? "WARNING" : level.toUpperCase();
  process.stdout.write(`${JSON.stringify({ severity, event, ...fields })}\n`);
};

async function registry(): Promise<Registry> {
  if (env.RELAY_REGISTRY === "memory") {
    log("warn", "memory_registry", { note: "device records are lost on restart" });
    return new MemoryRegistry();
  }
  const project = env.FIRESTORE_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? (await metadataProject());
  return new FirestoreRegistry({
    project,
    ...(env.FIRESTORE_DATABASE ? { database: env.FIRESTORE_DATABASE } : {}),
    ...(env.FIRESTORE_EMULATOR_HOST ? { emulatorHost: env.FIRESTORE_EMULATOR_HOST } : {}),
  });
}

function push(): PushSender {
  const key = env.APNS_KEY ?? (env.APNS_KEY_FILE ? readFileSync(env.APNS_KEY_FILE, "utf8") : "");
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_TOPIC: topic } = env;
  if (!key || !keyId || !teamId || !topic) {
    log("warn", "push_disabled", { note: "set APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC" });
    return new DisabledPush();
  }
  return new ApnsPush({ key, keyId, teamId, topic });
}

const relay = createRelay({ registry: await registry(), push: push(), log });
const port = await relay.listen(Number(env.PORT ?? 8080));
log("info", "listening", { port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log("info", "stopping", { signal });
    void relay.close().then(() => process.exit(0));
  });
}
