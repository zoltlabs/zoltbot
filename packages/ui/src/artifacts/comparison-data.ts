import {
  type Artifact,
  ArtifactSchema,
  type ArtifactVersion,
  ArtifactVersionSchema,
  parse,
} from "@zoltbot/protocol";
import type { Row } from "../chat/types.js";

export const visualKinds = new Set(["document", "page", "design", "chart", "diagram", "image"]);
export type VisualOption = { artifact: Artifact; version: ArtifactVersion };
/** Compare exact saved versions, including a previous revision as the baseline. */
export function visualOptions(
  artifacts: Row[],
  versions: Row[],
  threadIds: string[],
): VisualOption[] {
  const allowed = new Set(threadIds);
  const result: VisualOption[] = [];
  for (const row of artifacts) {
    if (
      !allowed.has(String(row.threadId)) ||
      row.state !== "active" ||
      !visualKinds.has(String(row.kind))
    )
      continue;
    const artifact = parse(ArtifactSchema, row);
    for (const entry of versions) {
      if (entry.artifactId !== artifact.id || entry.held || entry.metadataOnly) continue;
      result.push({ artifact, version: parse(ArtifactVersionSchema, entry) });
    }
  }
  return result.sort(
    (a, b) =>
      b.version.createdAt.localeCompare(a.version.createdAt) || b.version.number - a.version.number,
  );
}
