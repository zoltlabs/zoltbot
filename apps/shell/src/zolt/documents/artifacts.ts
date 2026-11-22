import {
  type ArtifactRef,
  type ArtifactVersions,
  DOCUMENT_LIMITS,
  type DocumentRef,
  type SaveArtifactInput,
} from "../../shared/documents";
import type { DaemonClient, Row } from "../daemon-client";
import { text } from "../mapping";
import type { DocumentsService } from "./service";

const MARKDOWN = /\.(md|markdown)$/i;

interface ArtifactDetail {
  artifact: Row;
  version: Row;
  manifest: { entry: string; files: Array<{ path: string; hash: string; bytes: number }> } | null;
}

/** An agent's artifacts as text: their versions, the Markdown of one, and saving it as a document. */
export function artifactDocuments(client: DaemonClient, documents: DocumentsService) {
  const detail = (input: { artifactId: string; versionId?: string }) =>
    client.call("artifact.get", {
      id: input.artifactId,
      ...(input.versionId ? { versionId: input.versionId } : {}),
    }) as Promise<ArtifactDetail>;

  async function markdown(input: ArtifactRef): Promise<{ text: string; projectId: string | null }> {
    const { artifact, manifest } = await detail(input);
    const entry = manifest?.files.find((file) => file.path === manifest.entry);
    if (!manifest || !entry) throw new Error("This version's files aren't on this Mac.");
    if (!MARKDOWN.test(entry.path)) throw new Error("Only Markdown artifacts can be read as text.");
    if (entry.bytes > DOCUMENT_LIMITS.bytes)
      throw new Error("This artifact is too large to open as text.");
    const bytes = await client.fetchAsset("blob", entry.hash, DOCUMENT_LIMITS.bytes);
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      projectId: text(artifact.projectId) || null,
    };
  }

  return {
    async versions(artifactId: string): Promise<ArtifactVersions> {
      const [{ items }, current] = await Promise.all([
        client.call("artifact.versions", { id: artifactId }) as Promise<{ items: Row[] }>,
        detail({ artifactId }),
      ]);
      return {
        projectId: text(current.artifact.projectId) || null,
        markdown: MARKDOWN.test(current.manifest?.entry ?? ""),
        versions: items.map((version) => ({
          versionId: text(version.id),
          number: Number(version.number),
          manifestHash: version.metadataOnly === true ? null : text(version.manifestHash) || null,
          by: text((version.producedBy as Row | undefined)?.profile) || null,
          createdAt: text(version.createdAt),
        })),
      };
    },
    async text(input: ArtifactRef): Promise<string> {
      return (await markdown(input)).text;
    },
    async save(input: SaveArtifactInput): Promise<DocumentRef> {
      const source = await markdown(input);
      if (!source.projectId) throw new Error("This artifact doesn't belong to a project.");
      await documents.create({ projectId: source.projectId, path: input.path, text: source.text });
      return { projectId: source.projectId, path: input.path };
    },
  };
}
