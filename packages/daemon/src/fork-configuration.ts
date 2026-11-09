import type { ForkProvenance, PermissionProfile } from "@zoltbot/protocol";
import {
  composeLaunchManifest,
  type LaunchManifest,
} from "../../connections/src/launch-manifest.js";

export function inheritedConfiguration(
  value: unknown,
  childId: string,
  ceiling: PermissionProfile,
) {
  if (!value || typeof value !== "object") throw Error("fork_configuration_unavailable");
  const saved = structuredClone(value) as Record<string, unknown>;
  const manifest = saved.launchManifest as LaunchManifest | undefined;
  if (saved.version !== 1 || !saved.profile || !manifest)
    throw Error("fork_configuration_unavailable");
  // Execution-owned browser/artifact bindings need their own child lifecycle, never source reuse.
  if (manifest.artifact || manifest.browser) throw Error("fork_execution_context_unavailable");
  const profile = saved.profile as { permissionProfile: PermissionProfile };
  profile.permissionProfile = ceiling;
  saved.launchManifest = composeLaunchManifest(
    {
      executionId: childId,
      threadId: childId,
      profileId: manifest.profileId,
      ...(manifest.projectId ? { projectId: manifest.projectId } : {}),
      cwd: manifest.cwd,
      configurationHash: manifest.configurationHash,
    },
    {
      connections: manifest.connections,
      skills: manifest.skills,
      ...(manifest.knowledge ? { knowledge: manifest.knowledge } : {}),
      ...(manifest.baseCommit ? { baseCommit: manifest.baseCommit } : {}),
      ...(manifest.hostTools ? { hostTools: manifest.hostTools } : {}),
    },
    { limit: manifest.budget.limit, fixed: manifest.budget.fixed },
  );
  return saved;
}
export function forkCeiling(
  profile: PermissionProfile,
  source: PermissionProfile,
  compare: unknown,
): PermissionProfile {
  const order: PermissionProfile[] = [
    "read_only",
    "workspace_write",
    "workspace_write_net",
    "full_access",
  ];
  return (
    order[
      Math.min(order.indexOf(profile), order.indexOf(source), compare === "read_only" ? 0 : 3)
    ] ?? "read_only"
  );
}
export function forkPermission(
  thread: { fork?: unknown },
  current: PermissionProfile,
): PermissionProfile {
  const fork = thread.fork as ForkProvenance | undefined;
  return fork ? forkCeiling(current, fork.permissionCeiling, undefined) : current;
}
