// S10: an artifact's published link and repository state, read from the snapshot, for the
// phone's artifact screen. The Mac publishes links (S1) and records them as daemon settings.
import { text } from "@zoltbot/ui/chat/types";
import type { Row, Snapshot } from "./transport.js";

export interface ArtifactShareLink {
  url: string;
  visibility: "private" | "public";
  /** False when the link shows an older version than the artifact's current one. */
  current: boolean;
}

export interface ArtifactActionsView {
  artifactId: string;
  versionId: string;
  title: string;
  link: ArtifactShareLink | null;
  /** The repository line, or null when the artifact has no repository to save into. */
  repository: { line: string; canAdd: boolean; held: boolean } | null;
}

const LINES: Record<string, string> = {
  local: "",
  pending: "Waiting to save",
  written: "Saved to the repository",
  partial: "Saved without files over 1 MB",
  held_secret: "Not saved: may contain a secret",
  from_repository: "From the repository",
};

function link(snapshot: Snapshot, artifact: Row): ArtifactShareLink | null {
  const key = `artifact.share.${text(artifact.id)}`;
  const value = snapshot.entities.settings?.find((row) => row.key === key)?.value as
    | Row
    | null
    | undefined;
  if (!value || typeof value.url !== "string" || !/^https:\/\//.test(value.url)) return null;
  const version = snapshot.entities.artifactVersion?.find(
    (row) => row.id === artifact.currentVersionId,
  );
  return {
    url: value.url,
    visibility: value.visibility === "public" ? "public" : "private",
    current: !!version && version.manifestHash === value.manifestHash,
  };
}

const ERRORS: Record<string, string> = {
  artifact_has_no_repository_folder: "This project has no repository folder to save into.",
  artifact_files_unavailable: "This version’s files aren’t on the Mac, so it can’t be saved.",
  artifact_blob_corrupt: "This version’s files changed on the Mac, so it can’t be saved.",
  artifact_repository_file_denied:
    "A file in the repository is in the way. Move it out of .zoltbot/artifacts and try again.",
};

/** What to tell the owner when Add to the repository fails. */
export function repositoryError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  const known = Object.keys(ERRORS).find((key) => code.includes(key));
  return known ? (ERRORS[known] as string) : "Couldn’t save to the repository. Try again.";
}

export const STILL_HELD =
  "Still not saved: another saved version of this artifact may contain a secret.";

/** The chat's active artifacts, newest first, with their link and repository state. */
export function artifactActions(snapshot: Snapshot, threadId: string): ArtifactActionsView[] {
  return (snapshot.entities.artifact ?? [])
    .filter((row) => row.threadId === threadId && row.state === "active")
    .sort((a, b) => text(b.updatedAt).localeCompare(text(a.updatedAt)))
    .map((artifact) => {
      let state = text(artifact.repositoryState) || "local";
      // As on the Mac: a project set to "Only when I ask" never writes a pending version itself.
      const project = snapshot.entities.project?.find((row) => row.id === artifact.projectId);
      if (state === "pending" && project?.artifactRepositoryMode === "off") state = "local";
      return {
        artifactId: text(artifact.id),
        versionId: text(artifact.currentVersionId),
        title: text(artifact.title) || "Artifact",
        link: link(snapshot, artifact),
        repository: text(artifact.repositoryRoot)
          ? {
              line: LINES[state] ?? "",
              canAdd: state === "local" || state === "pending",
              held: state === "held_secret",
            }
          : null,
      };
    });
}
