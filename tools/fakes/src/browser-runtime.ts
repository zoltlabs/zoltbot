import { copyFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "@zoltbot/store";
import type { LaunchManifest } from "../../../packages/connections/src/launch-manifest.js";
import { registerEvidence } from "../../../packages/daemon/src/browser/evidence.js";
import {
  browserBinding,
  materializeBrowser,
} from "../../../packages/daemon/src/browser/runtime.js";
import type { RuntimeHost } from "../../../packages/daemon/src/runtime-host.js";
/** UI-only fixture: native execution and pixel acceptance are tested separately. */
export function referenceBrowser(
  store: Store,
  input: Parameters<RuntimeHost["prepare"]>[0],
  cwd: string,
  configuration?: { launchManifest: LaunchManifest },
) {
  if (!configuration || !input.thread.taskId || process.env.ZOLTBOT_BROWSER_FIXTURE !== "1")
    return undefined;
  const task = store.record("task", input.thread.taskId);
  if (!task?.browser) return undefined;
  const selection = task.browser as { mode: "background" | "visible"; url?: string };
  const binding = configuration.launchManifest.browser ?? browserBinding(cwd, cwd, selection);
  const manifest = { ...configuration.launchManifest, browser: binding };
  return {
    configuration: { launchManifest: manifest },
    register(sessionId: string) {
      materializeBrowser(binding);
      copyFileSync(
        path.resolve("fixtures/browser/local-form.png"),
        path.join(binding.artifactRoot, "capture.png"),
      );
      registerEvidence(
        store,
        { agentId: input.profile.id, threadId: input.thread.id, sessionId },
        {
          path: "capture.png",
          url: selection.url ?? "http://127.0.0.1:3000",
          viewport: { width: 1280, height: 720 },
          check: "Local fake form submitted",
          outcome: "passed",
          inspection: "agent_reported",
        },
      );
    },
  };
}
