import type { Project } from "@zoltbot/protocol";

export function macFolder(value: string): string | undefined {
  const path = value.trim();
  return path.startsWith("/") && !path.includes("\0") ? path : undefined;
}
export function newProject(id: string, name: string, folder: string, at: string): Project {
  const path = macFolder(folder);
  if (!path || !name.trim())
    throw new Error("Enter a name and an absolute folder path on your Mac.");
  return {
    id,
    name: name.trim(),
    goal: "",
    instructions: "",
    constraints: "",
    roots: [{ path, label: name.trim() }],
    hierarchyDepth: 1,
    tags: [],
    requireCodeReview: true,
    skipFinalGateWhenReviewed: false,
    archived: false,
    createdAt: at,
  };
}
