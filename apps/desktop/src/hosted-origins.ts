// Official builds name their hosted service origin when packaged (scripts/package-desktop.mjs).
// Explicit environment settings still win, so developers and forks can point elsewhere.
export function hostedOrigins(env: Record<string, string | undefined>, manifest?: string) {
  const packaged = manifest
    ? (JSON.parse(manifest) as { zoltbot?: { hostedOrigin?: string; relayUrl?: string } }).zoltbot
    : undefined;
  return {
    cloud: env.ZOLTBOT_CLOUD_ORIGIN || packaged?.hostedOrigin,
    broker: env.ZOLTBOT_BROKER_ORIGIN || packaged?.hostedOrigin,
    relay: env.ZOLTBOT_RELAY_URL || packaged?.relayUrl,
  };
}
