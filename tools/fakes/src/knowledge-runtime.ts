import { randomUUID } from "node:crypto";
import type { Store } from "@zoltbot/store";
import {
  composeLaunchManifest,
  type LaunchManifest,
} from "../../../packages/connections/src/launch-manifest.js";
import { knowledgeLaunch } from "../../../packages/daemon/src/knowledge-launch.js";
import type { RuntimeHost } from "../../../packages/daemon/src/runtime-host.js";

/** Reference provider uses the same frozen knowledge intent as production native adapters. */
export function referenceKnowledge(
  store: Store,
  input: Parameters<RuntimeHost["prepare"]>[0],
  cwd: string,
) {
  const previous = input.previous?.configuration as { launchManifest?: LaunchManifest } | undefined;
  const knowledge = previous?.launchManifest?.knowledge ?? knowledgeLaunch(store, input, 1200);
  const manifest =
    previous?.launchManifest ??
    composeLaunchManifest(
      {
        executionId: randomUUID(),
        threadId: input.thread.id,
        // Chats get packs too (D-KNW-1); only task runs carry a task revision.
        ...(input.thread.taskId
          ? {
              taskId: input.thread.taskId,
              taskRevision: Number(store.record("task", input.thread.taskId)?.revision ?? 1),
            }
          : {}),
        ...(input.thread.projectId ? { projectId: input.thread.projectId } : {}),
        profileId: input.profile.id,
        cwd,
        configurationHash: "reference-knowledge-fixture",
      },
      { ...(knowledge ? { knowledge } : {}) },
      { limit: 1500, fixed: 0 },
    );
  return {
    configuration: { launchManifest: manifest },
    ...(manifest.knowledge ? { firstTurnKnowledge: manifest.knowledge } : {}),
  };
}
