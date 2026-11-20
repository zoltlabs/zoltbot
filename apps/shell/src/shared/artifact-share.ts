// S1: publishing an artifact as a link, over IPC. Main talks to the account service; the
// renderer never sees tokens or content capabilities.

export type ArtifactVisibility = "private" | "public";

export interface ArtifactLink {
  id: string;
  visibility: ArtifactVisibility;
  url: string;
  /** False when the link shows an older version than the one open. */
  current: boolean;
}

export type ArtifactShareState =
  /** This build can't publish, or the account can't store artifacts. */
  { kind: "unavailable" } | { kind: "signed-out" } | { kind: "ready"; link: ArtifactLink | null };

export interface ArtifactShareTarget {
  /** The daemon's artifact id. Its link is recorded against this id, never matched by title. */
  artifactId: string;
  manifestHash: string;
  title: string;
}

/**
 * The online copy published for an artifact, kept as the daemon setting `artifact.share.<id>`
 * so the phone can show it too (S10). Null after unpublishing.
 */
export interface ArtifactShareRecord {
  id: string;
  manifestHash: string;
  visibility: ArtifactVisibility;
  url: string;
}

/** One Share call from the panel, given what it acts on. */
export type ArtifactShareWork = (target: ArtifactShareTarget) => Promise<ArtifactLink | null>;

export const artifactShareKey = (artifactId: string) => `artifact.share.${artifactId}`;

export const ARTIFACT_SHARE_CHANNELS = {
  artifactShareStatus: "artifact-share:status",
  artifactSharePublish: "artifact-share:publish",
  artifactShareSetVisibility: "artifact-share:set-visibility",
  artifactShareReplace: "artifact-share:replace",
  artifactShareUnpublish: "artifact-share:unpublish",
  artifactShareCopy: "artifact-share:copy",
} as const;

export interface ArtifactShareDesktopApi {
  status: (target: ArtifactShareTarget) => Promise<ArtifactShareState>;
  publish: (
    input: ArtifactShareTarget & { visibility: ArtifactVisibility },
  ) => Promise<ArtifactLink>;
  /** Only for a link that shows the open version. */
  setVisibility: (
    input: ArtifactShareTarget & { visibility: ArtifactVisibility },
  ) => Promise<ArtifactLink>;
  /** Takes the older link down, then publishes the open version at a new link. */
  replace: (target: ArtifactShareTarget) => Promise<ArtifactLink>;
  unpublish: (target: ArtifactShareTarget) => Promise<void>;
  copy: (target: ArtifactShareTarget) => Promise<void>;
}
