// S2: the artifact panel's repository state and Add to repository, and the project's choice of
// when artifacts are written into its repository.
import { randomUUID } from "node:crypto";
import type {
  ArtifactRepositoryMode,
  ArtifactRepositoryState,
  ArtifactRepositoryView,
  ProjectRepositoryMode,
} from "../shared/artifact-repository";
import { ARTIFACT_REPOSITORY_CHANNELS as C } from "../shared/artifact-repository";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "rows" | "call">;

const STATES = new Set<ArtifactRepositoryState>([
  "local",
  "pending",
  "written",
  "held_secret",
  "partial",
  "from_repository",
]);
const MODES = new Set<ArtifactRepositoryMode>(["every_save", "on_accept", "off"]);

const ERRORS: Record<string, string> = {
  artifact_has_no_repository_folder: "This project has no repository folder to save into.",
  artifact_files_unavailable: "This version’s files aren’t on this Mac, so it can’t be saved.",
  artifact_blob_corrupt: "This version’s files changed on this Mac, so it can’t be saved.",
  artifact_repository_file_denied:
    "A file in the repository is in the way. Move it out of .zoltbot/artifacts and try again.",
  artifact_version_scope_denied: "This version changed. Reopen the artifact and try again.",
};

/** The artifact's repository state, or null when it has no repository to save into. */
export function repositoryView(client: Client, artifactId: string): ArtifactRepositoryView | null {
  const artifact = client.rows("artifact").find((row) => row.id === artifactId);
  if (!artifact || artifact.state === "archived" || typeof artifact.repositoryRoot !== "string")
    return null;
  if (!artifact.repositoryRoot) return null;
  let state = artifact.repositoryState as ArtifactRepositoryState;
  if (!STATES.has(state)) state = "local";
  // A project set to "Only when I ask" never writes a pending version by itself.
  const project = client.rows("project").find((row) => row.id === artifact.projectId);
  if (state === "pending" && project?.artifactRepositoryMode === "off") state = "local";
  return {
    state,
    versionId: String(artifact.currentVersionId ?? ""),
  };
}

/** The mode of a chat's project; null when the chat has no project with a repository. */
export function projectMode(client: Client, botId: string): ProjectRepositoryMode | null {
  const thread = client.rows("thread").find((row) => row.id === botId);
  const project = client
    .rows("project")
    .find((row) => row.id === thread?.projectId && row.archived !== true);
  const roots = Array.isArray(project?.roots) ? (project.roots as Record<string, unknown>[]) : [];
  if (!project || !roots.some((root) => typeof root.repoRoot === "string" && root.repoRoot))
    return null;
  const mode = project.artifactRepositoryMode as ArtifactRepositoryMode;
  // The daemon writes on task acceptance when a project never chose.
  return { projectId: String(project.id), mode: MODES.has(mode) ? mode : "on_accept" };
}

async function friendly<T>(fallback: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    throw new Error(ERRORS[code] ?? fallback);
  }
}

export function artifactRepositoryHandlers(
  client: Client,
): Record<string, (input: unknown) => unknown> {
  return {
    [C.artifactRepositoryState]: (input) =>
      repositoryView(client, requireString(input, "artifactId")),
    [C.artifactRepositoryAdd]: (input) =>
      friendly("Couldn’t save to the repository. Try again.", async () => {
        if (!isObject(input)) throw new Error("Invalid artifact.");
        const artifactId = requireString(input.artifactId, "artifactId");
        const versionId = requireString(input.versionId, "versionId");
        const result = (await client.call(
          "artifact.add_to_repository",
          { id: artifactId, versionId, allowHeld: input.allowHeld === true },
          randomUUID(),
        )) as { held?: boolean; partial?: boolean } | null;
        // The snapshot may not have the change yet, so the answer decides the new state.
        const view = repositoryView(client, artifactId);
        if (!view || view.versionId !== versionId) return view;
        const state = result?.held ? "held_secret" : result?.partial ? "partial" : "written";
        return { ...view, state } satisfies ArtifactRepositoryView;
      }),
    [C.artifactRepositoryMode]: (input) => projectMode(client, requireString(input, "botId")),
    [C.artifactRepositorySetMode]: (input) =>
      friendly("Couldn’t change when artifacts are saved. Try again.", async () => {
        if (!isObject(input)) throw new Error("Invalid project.");
        const projectId = requireString(input.projectId, "projectId");
        const mode = input.mode as ArtifactRepositoryMode;
        if (!MODES.has(mode)) throw new Error("Invalid mode.");
        await client.call(
          "project.update",
          { id: projectId, changes: { artifactRepositoryMode: mode } },
          randomUUID(),
        );
      }),
  };
}
