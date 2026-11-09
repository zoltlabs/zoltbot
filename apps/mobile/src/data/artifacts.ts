import { compareSessions } from "@zoltbot/protocol";
import { text } from "@zoltbot/ui/chat/types";
import type { Row, Snapshot } from "./transport.js";

export interface ArtifactCard {
  artifactId: string;
  versionId: string;
  title: string;
  kind: string;
  number: number | null;
  newer: boolean;
  availability: "mac" | "held" | "unavailable";
}

export function artifactCard(artifact: Row, version: Row): ArtifactCard {
  const number = Number(version.number);
  return {
    artifactId: text(artifact.id),
    versionId: text(version.id),
    title: text(artifact.title) || "Artifact",
    kind: text(artifact.kind) || "visual",
    number: Number.isInteger(number) && number > 0 ? number : null,
    newer: !!artifact.currentVersionId && artifact.currentVersionId !== version.id,
    availability:
      version.held === true ? "held" : version.metadataOnly === true ? "unavailable" : "mac",
  };
}

/** Resolve only the selected immutable version; never substitute the current version. */
export function artifactReference(snapshot: Snapshot, target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  const { artifactId, versionId } = target as Row;
  if (typeof artifactId !== "string" || typeof versionId !== "string") return undefined;
  const artifact = snapshot.entities.artifact?.find((row) => row.id === artifactId);
  const version = snapshot.entities.artifactVersion?.find(
    (row) => row.id === versionId && row.artifactId === artifactId,
  );
  return `${text(artifact?.title) || "Artifact"} · ${version ? `v${Number(version.number)}` : "selected version unavailable"}`;
}

/** Metadata only. Files, manifests, URLs and source never enter phone transcript rows. */
export function artifactOccurrences(snapshot: Snapshot, threadId: string) {
  const thread = snapshot.entities.thread?.find((row) => row.id === threadId);
  if (!thread) return [];
  const sessionIds = new Set(
    (snapshot.entities.session ?? [])
      .filter((row) => row.threadId === threadId)
      .map((row) => row.id),
  );
  const turnIds = new Set([
    ...(snapshot.entities.turn ?? [])
      .filter((row) => row.threadId === threadId)
      .map((row) => row.id),
    ...(snapshot.entities.item ?? [])
      .filter((row) => row.threadId === threadId)
      .map((row) => row.turnId),
  ]);
  const artifacts = new Map(
    (snapshot.entities.artifact ?? [])
      .filter(
        (row) =>
          row.state !== "archived" &&
          (thread.projectId
            ? row.projectId === thread.projectId
            : !row.projectId && row.threadId === threadId),
      )
      .map((row) => [row.id, row]),
  );
  const groups = new Map<string, { id: string; turnId: string; artifact: ArtifactCard }>();
  const versions = [
    ...new Map((snapshot.entities.artifactVersion ?? []).map((row) => [row.id, row])).values(),
  ].sort((a, b) => Number(a.number) - Number(b.number) || text(a.id).localeCompare(text(b.id)));
  for (const version of versions) {
    const artifact = artifacts.get(version.artifactId);
    const turnId = text(version.turnId);
    if (
      !artifact ||
      !(
        turnIds.has(turnId) ||
        sessionIds.has(version.sessionId) ||
        (!version.sessionId && artifact.threadId === threadId)
      )
    )
      continue;
    const id = `artifact:${turnId || "unavailable"}:${text(artifact.id)}`;
    groups.set(id, { id, turnId, artifact: artifactCard(artifact, version) });
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Metadata selection stays usable offline; preview bytes are fetched only for the chosen versions. */
export function comparisonVersions(snapshot: Snapshot, threadId: string) {
  const visible = new Set(
    artifactOccurrences(snapshot, threadId).map((o) => o.artifact.artifactId),
  );
  const artifacts = new Map(
    (snapshot.entities.artifact ?? [])
      .filter((a) => (a.threadId === threadId || visible.has(text(a.id))) && a.state === "active")
      .map((a) => [a.id, a]),
  );
  return (snapshot.entities.artifactVersion ?? [])
    .flatMap((version) => {
      const artifact = artifacts.get(version.artifactId);
      if (!artifact) return [];
      return [
        {
          artifact,
          version,
          label: `${text(artifact.title)} · v${version.number}`,
          available: !version.held && !version.metadataOnly,
        },
      ];
    })
    .sort(
      (a, b) =>
        text(b.version.createdAt).localeCompare(text(a.version.createdAt)) ||
        Number(b.version.number) - Number(a.version.number),
    );
}
export function versionDraft(title: string, version: Row, feedback: string) {
  return `Use “${title}” v${version.number} (${text(version.id)})${feedback.trim() ? `: ${feedback.trim()}` : "."}`;
}

/** Same eligibility as the desktop composer; the daemon remains authoritative at send time. */
export function revisionAvailable(snapshot: Snapshot, threadId: string) {
  const e = snapshot.entities;
  const thread = e.thread?.find((t) => t.id === threadId);
  if (!thread || thread.taskId || thread.archived) return false;
  const session = e.session?.filter((s) => s.threadId === threadId).sort(compareSessions)[0];
  const value = e.settings?.find((s) => s.key === `runtime.configuration.${session?.id}`)?.value as
    | { launchManifest?: { artifact?: { sourceRead?: number } } }
    | undefined;
  return value?.launchManifest?.artifact?.sourceRead === 1;
}
