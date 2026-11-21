// A4: read and change a project's co-author line setting.
import { randomUUID } from "node:crypto";
import { CO_AUTHOR_CHANNELS as C, type ProjectCoAuthor } from "../shared/co-author";
import type { DaemonClient } from "./daemon-client";
import { isObject, requireString } from "./parsers";

type Client = Pick<DaemonClient, "rows" | "call">;

/** The project of a chat, when it has a repository to commit to. */
export function projectCoAuthor(client: Client, botId: string): ProjectCoAuthor | null {
  const thread = client.rows("thread").find((row) => row.id === botId);
  const project = client
    .rows("project")
    .find((row) => row.id === thread?.projectId && row.archived !== true);
  const roots = Array.isArray(project?.roots) ? (project.roots as Record<string, unknown>[]) : [];
  if (!project || !roots.some((root) => typeof root.repoRoot === "string" && root.repoRoot))
    return null;
  return { projectId: String(project.id), enabled: project.coAuthorLine !== false };
}

export function coAuthorHandlers(client: Client): Record<string, (input: unknown) => unknown> {
  return {
    [C.coAuthorGet]: (input) => projectCoAuthor(client, requireString(input, "botId")),
    [C.coAuthorSet]: async (input) => {
      if (!isObject(input) || typeof input.enabled !== "boolean")
        throw new Error("Invalid setting.");
      await client.call(
        "project.update",
        {
          id: requireString(input.projectId, "projectId"),
          changes: { coAuthorLine: input.enabled },
        },
        randomUUID(),
      );
    },
  };
}
