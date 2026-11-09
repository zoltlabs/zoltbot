import { randomUUID } from "node:crypto";
import type { DomainState } from "@zoltbot/core";
import { compareSessions, type DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import type { LaunchManifest } from "../../connections/src/launch-manifest.js";

export function interruptedLaunchConfiguration(state: DomainState, threadId: string): unknown {
  const latest = (state.session ?? [])
    .filter((s) => s.threadId === threadId)
    .sort(compareSessions)[0];
  if (!latest || latest.nativeId) return undefined;
  const configuration = state.settings?.find(
    (s) => s.key === `runtime.configuration.${latest.id}`,
  )?.value;
  const manifest = (configuration as { launchManifest?: LaunchManifest } | undefined)
    ?.launchManifest;
  if (!manifest) return undefined;
  if (state.settings?.some((s) => s.key === `runtime.launchClaim.${latest.id}` && s.value === true))
    throw new Error("native_start_uncertain");
  return configuration;
}
export function claimManifestOpen(
  store: Store,
  sessionId: string,
  configuration: Record<string, unknown> | undefined,
  publish: (events: DomainEvent[]) => void,
  claimed = true,
) {
  if (!configuration?.launchManifest) return;
  const commandId = `launch-claim:${sessionId}:${claimed}:${randomUUID()}`;
  const before = store.lastSeq();
  store.dispatch(commandId, () => ({
    result: {},
    events: [
      {
        eventId: `${commandId}:0`,
        aggregateType: "settings",
        aggregateId: `runtime.launchClaim.${sessionId}`,
        type: "settings.created",
        occurredAt: new Date().toISOString(),
        payload: { key: `runtime.launchClaim.${sessionId}`, value: claimed },
      },
    ],
  }));
  publish(store.eventsSince(before));
}
export function bindManifestNative(
  store: Store,
  state: DomainState,
  sessionId: string,
  nativeId: string,
) {
  const config = state.settings?.find((s) => s.key === `runtime.configuration.${sessionId}`)
    ?.value as { launchManifest?: LaunchManifest } | undefined;
  const manifest = config?.launchManifest;
  if (!manifest) return;
  const result = store.database
    .prepare(
      "UPDATE launch_manifests_aux SET native_id=?,state='bound' WHERE id=? AND (native_id IS NULL OR native_id=?)",
    )
    .run(nativeId, manifest.id, nativeId);
  if (result.changes !== 1) throw new Error("launch_manifest_binding_conflict");
}
