import type { PermissionProfile, Profile, Thread } from "@zoltbot/protocol";

export function starterDraft(
  definition: { id: string; displayName: string },
  ids: { profile: string; thread: string },
  at: string,
  projectId?: string,
  permissionProfile: PermissionProfile = "workspace_write",
): { profile: Profile; thread: Thread } {
  return {
    profile: {
      id: ids.profile,
      name: definition.displayName,
      avatar: definition.displayName.slice(0, 1) || "A",
      kind: "profile",
      definitionId: definition.id,
      permissionProfile,
      instructions: "",
      hidden: false,
      archived: false,
    },
    thread: {
      id: ids.thread,
      agentId: ids.profile,
      ...(projectId ? { projectId } : {}),
      kind: "main",
      title: "New conversation",
      titleSource: "auto",
      pinned: false,
      archived: false,
      createdAt: at,
      lastActivityAt: at,
    },
  };
}
