import { createHash } from "node:crypto";
import path from "node:path";
import {
  type Artifact,
  ArtifactManifestSchema,
  ArtifactSchema,
  type ArtifactVersion,
  ArtifactVersionSchema,
  type DomainEvent,
  type EntityKind,
  parse,
  parseEvent,
} from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
export const artifactDirectory = (store: Store) =>
  path.join(path.dirname(store.database.name), "artifacts");
export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function artifactRecord(store: Store, id: string): Artifact {
  const row = store.record("artifact", id);
  if (!row) throw Error("artifact_not_found");
  return parse(ArtifactSchema, row);
}
export function artifactVersion(store: Store, id: string): ArtifactVersion {
  const row = store.record("artifactVersion", id);
  if (!row) throw Error("artifact_version_not_found");
  return parse(ArtifactVersionSchema, row);
}
export function versionDetail(store: Store, id: string) {
  const row = store.database
    .prepare("SELECT manifest,save_checks FROM artifact_manifests_aux WHERE version_id=?")
    .get(id) as { manifest: string; save_checks: string } | undefined;
  if (!row) throw Error("artifact_files_unavailable");
  return {
    manifest: parse(ArtifactManifestSchema, JSON.parse(row.manifest)),
    saveChecks: JSON.parse(row.save_checks) as string[],
  };
}
export function artifactEvent(
  kind: EntityKind,
  body: Record<string, unknown>,
  commandId: string,
  index: number,
  created: boolean,
): DomainEvent {
  const prefix =
    kind === "artifactVersion"
      ? "artifact_version"
      : kind === "artifactComment"
        ? "artifact_comment"
        : kind;
  return parseEvent({
    eventId: `${commandId}:${index}`,
    commandId,
    aggregateType: kind,
    aggregateId: String(body.id),
    type: `${prefix}.${created ? "created" : "updated"}`,
    occurredAt: String(body.updatedAt ?? body.createdAt),
    payload: body,
  });
}
export { validateManifest } from "@zoltbot/artifact-validation";
export function artifactPage(
  store: Store,
  options: {
    projectId?: string;
    threadId?: string;
    query?: string;
    kind?: string;
    cursor?: string;
    limit?: number;
  },
) {
  const matches = options.query?.trim()
    ? new Set(
        (
          store.database
            .prepare("SELECT id FROM artifacts_fts WHERE artifacts_fts MATCH ? LIMIT 500")
            .all(`"${options.query.slice(0, 200).replaceAll('"', '""')}"`) as { id: string }[]
        ).map((r) => r.id),
      )
    : undefined;
  const rows = (store.snapshot(["artifact"]).artifact ?? [])
    .filter(
      (row) =>
        row.state !== "archived" &&
        (!options.projectId || row.projectId === options.projectId) &&
        (!options.threadId || row.threadId === options.threadId) &&
        (!options.kind || row.kind === options.kind) &&
        (!matches || matches.has(String(row.id))),
    )
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return rows
    .filter((r) => !options.cursor || String(r.id) > options.cursor)
    .slice(0, Math.min(100, options.limit ?? 30));
}
