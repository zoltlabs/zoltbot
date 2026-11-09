import { comparePermission, routineProfile } from "@zoltbot/core";
import {
  AgentDefinitionSchema,
  compareSessions,
  ProfileSchema,
  parse,
  ThreadSchema,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { interruptedLaunchConfiguration } from "./connections-delivery.js";
import { forkPermission } from "./fork-configuration.js";
import { Redactor } from "./logging.js";
import type { PrivateVault } from "./private-context.js";
import { resolveRuntimeCredentials } from "./runtime-credentials.js";
import type { RuntimeHost } from "./runtime-host.js";

export async function launchPreflight(
  store: Store,
  host: RuntimeHost,
  threadId: string,
  vault?: PrivateVault,
) {
  const state = store.snapshot();
  const thread = parse(
    ThreadSchema,
    state.thread?.find((row) => row.id === threadId),
  );
  const profile = routineProfile(
    state,
    thread.taskId,
    parse(
      ProfileSchema,
      state.agent?.find((row) => row.id === thread.agentId),
    ),
  );
  const definition = parse(
    AgentDefinitionSchema,
    state.agentDefinition?.find((row) => row.id === profile.definitionId),
  );
  const last = (state.session ?? [])
    .filter((row) => row.threadId === threadId && typeof row.nativeId === "string")
    .sort(compareSessions)[0];
  const redactor = new Redactor();
  const resolved = await resolveRuntimeCredentials(definition, vault, redactor);
  await host.prepare(
    {
      thread,
      routineInputs: state.task?.find((row) => row.id === thread.taskId)?.routineInputs as
        | import("@zoltbot/protocol").Routine["template"]["inputs"]
        | undefined,
      profile: {
        ...profile,
        permissionProfile:
          comparePermission(state, threadId, profile) ??
          forkPermission(thread, profile.permissionProfile),
      },
      comparePermission: comparePermission(state, threadId, profile),
      definition: resolved.definition,
      ...(!last ? { launchConfiguration: interruptedLaunchConfiguration(state, threadId) } : {}),
      ...(last
        ? {
            previous: {
              nativeId: String(last.nativeId),
              cwd: String(last.cwd),
              provider: String(last.provider),
              configuration: state.settings?.find(
                (row) => row.key === `runtime.configuration.${last.id}`,
              )?.value,
            },
          }
        : {}),
    },
    redactor,
  );
}
