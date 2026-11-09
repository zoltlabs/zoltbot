import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ArtifactBinding, HostToolDefinition } from "@zoltbot/protocol";
import { contentHash } from "./model.js";
export function createArtifactBinding(cwd: string, repositoryRoot?: string): ArtifactBinding {
  const id = randomUUID();
  const stagingRoot = path.join(cwd, ".zoltbot", "staging", id);
  const guidanceText = `Prefer artifacts for visual explanations, comparisons, charts, designs and tools; chat/files for short answers, code changes and repo docs. Follow Output. Reuse keys for revisions. Offline: bundled assets only, no external network/storage. read(id,versionId,path,cursor) recovers text. Stage under .zoltbot/staging/${id} relative to your working folder, or inline small files. read(template) provides offline starters. Save templates with kit:v1. Include source notes and a short explanation in chat; label illustrative data.`;
  return {
    version: 1,
    id,
    toolsVersion: 2,
    sourceRead: 1,
    stagingRoot,
    ...(repositoryRoot ? { repositoryRoot } : {}),
    guidanceText,
    guidanceHash: contentHash(guidanceText),
  };
}
export function frozenArtifactGuidance(binding: ArtifactBinding) {
  if (contentHash(binding.guidanceText) !== binding.guidanceHash)
    throw Error("artifact_guidance_changed");
  return binding.guidanceText;
}
export type ArtifactToolSurface = (
  artifact: boolean,
  browser: boolean,
  thread?: { id: string },
) => HostToolDefinition[];
