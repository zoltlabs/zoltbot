// S2: saving artifacts into the project's repository, over IPC.

/** Where the open version stands in the project's repository. */
export type ArtifactRepositoryState =
  | "local"
  | "pending"
  | "written"
  | "held_secret"
  | "partial"
  | "from_repository";

export interface ArtifactRepositoryView {
  state: ArtifactRepositoryState;
  /** The version the state describes: the artifact's current one. */
  versionId: string;
}

/** When a project's artifacts are written into its repository. */
export type ArtifactRepositoryMode = "every_save" | "on_accept" | "off";

export interface ProjectRepositoryMode {
  projectId: string;
  mode: ArtifactRepositoryMode;
}

export const ARTIFACT_REPOSITORY_CHANNELS = {
  artifactRepositoryState: "artifact-repository:state",
  artifactRepositoryAdd: "artifact-repository:add",
  artifactRepositoryMode: "artifact-repository:mode",
  artifactRepositorySetMode: "artifact-repository:set-mode",
} as const;

export interface ArtifactRepositoryDesktopApi {
  /** Null when the artifact has no repository to save into. */
  state: (artifactId: string) => Promise<ArtifactRepositoryView | null>;
  add: (input: {
    artifactId: string;
    versionId: string;
    allowHeld: boolean;
  }) => Promise<ArtifactRepositoryView | null>;
  /** The mode of a chat's project, or null when the chat has no project with a repository. */
  mode: (botId: string) => Promise<ProjectRepositoryMode | null>;
  setMode: (input: ProjectRepositoryMode) => Promise<void>;
}
