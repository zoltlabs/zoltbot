import type { Store } from "@zoltbot/store";
import { expect } from "vitest";
/** Real production host transport with synthetic native providers, never a live canary. */
export async function verifyArtifactHostRoundTrip(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  store: Store,
) {
  await call("turn.send", {
    threadId: "thread",
    mode: "queue",
    input: [{ type: "text", text: "artifact_page" }],
  });
  await expect
    .poll(() => store.snapshot(["artifact"]).artifact?.find((a) => a.key === "provider-page"), {
      timeout: 7000,
    })
    .toBeDefined();
  const first = store.snapshot(["artifact"]).artifact?.find((a) => a.key === "provider-page");
  await expect
    .poll(
      () =>
        store
          .snapshot(["turn"])
          .turn?.some((t) => t.threadId === "thread" && t.status === "running"),
      { timeout: 7000 },
    )
    .toBe(false);
  await call("turn.send", {
    threadId: "thread",
    mode: "queue",
    input: [{ type: "text", text: "artifact_page_v2" }],
    artifactTarget: { artifactId: first?.id, versionId: first?.currentVersionId },
  });
  await expect
    .poll(
      () =>
        store
          .snapshot(["artifactVersion"])
          .artifactVersion?.filter((v) => v.artifactId === first?.id).length,
      { timeout: 7000 },
    )
    .toBe(2);
  const latest = store.snapshot(["artifact"]).artifact?.find((a) => a.key === "provider-page");
  expect(latest?.id).toBe(first?.id);
  expect(latest?.currentVersionId).not.toBe(first?.currentVersionId);
  expect(store.record("artifactVersion", String(latest?.currentVersionId))?.baseVersionId).toBe(
    first?.currentVersionId,
  );
}
