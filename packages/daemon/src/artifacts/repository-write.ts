import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { ArtifactManifest, ArtifactVersion } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { repository, repositoryLock } from "../../../gitkit/src/git.js";
import { blobBytes, checkedAncestors, possibleSecret } from "./intake.js";
import {
  artifactDirectory,
  artifactEvent,
  artifactRecord,
  artifactVersion,
  contentHash,
  versionDetail,
} from "./model.js";
import {
  atomicRepositoryFile,
  cleanupRepositoryTemps,
  existingRepositoryJson,
  replaceRepositoryFolder,
  repositoryDirectory,
  repositoryFileLimit,
} from "./repository-files.js";

export function taskArtifactVersions(store: Store, taskId: string, revision: number) {
  const rows = store.database
    .prepare(
      "SELECT artifact_id,version_id,repository_root FROM artifact_saves_aux WHERE task_id=? AND revision=? ORDER BY rowid DESC",
    )
    .all(taskId, revision) as {
    artifact_id: string;
    version_id: string;
    repository_root: string | null;
  }[];
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      if (seen.has(row.artifact_id)) return false;
      seen.add(row.artifact_id);
      return true;
    })
    .map((row) => ({
      artifactId: row.artifact_id,
      versionId: row.version_id,
      repositoryRoot: row.repository_root,
    }));
}
export async function writeRepositoryVersion(
  store: Store,
  artifactId: string,
  versionId: string,
  allowHeld = false,
  repositoryRoot?: string,
  privateCheck?: (text: string) => Promise<boolean>,
) {
  const artifact = artifactRecord(store, artifactId),
    version = artifactVersion(store, versionId);
  if (version.artifactId !== artifact.id || version.metadataOnly)
    throw Error("artifact_files_unavailable");
  if (version.held && !allowHeld) throw Error("artifact_held_possible_secret");
  const root = repositoryRoot ?? version.repositoryRoot ?? artifact.repositoryRoot;
  if (!root) throw Error("artifact_has_no_repository_folder");
  await checkedAncestors(root);
  let lock = root;
  try {
    lock = (await repository(root)).commonDir;
  } catch {
    /* Plain selected code folders are supported too. */
  }
  return repositoryLock(lock, async () => {
    const detail = versionDetail(store, version.id);
    const starredVersions = [...new Set(artifact.starredVersionIds)]
      .map((id) => artifactVersion(store, id))
      .filter(
        (star) =>
          star.artifactId === artifact.id &&
          !star.metadataOnly &&
          (!star.held || star.id === version.id),
      );
    const producerFor = (item: ArtifactVersion) => {
      const session = store.record("session", item.sessionId),
        thread = session ? store.record("thread", String(session.threadId)) : undefined,
        profile = thread ? store.record("agent", String(thread.agentId)) : undefined;
      return (
        item.producedBy ?? {
          provider: String(session?.provider ?? artifact.provider),
          profile: String(profile?.name ?? "From repository"),
        }
      );
    };
    const candidates = [version, ...starredVersions.filter((star) => star.id !== version.id)];
    const producers = new Map(candidates.map((item) => [item.id, producerFor(item)]));
    for (const item of candidates) {
      // A held override authorizes only the selected version, never another starred version.
      if (allowHeld && item.id === version.id) continue;
      const manifest =
        item.id === version.id ? detail.manifest : versionDetail(store, item.id).manifest;
      const metadata = JSON.stringify({
        key: artifact.key,
        title: artifact.title,
        note: item.note,
        by: producers.get(item.id),
        screens: manifest.screens,
      });
      if (possibleSecret("", metadata) || (await privateCheck?.(metadata)))
        throw Error("artifact_held_possible_secret");
      for (const file of manifest.files) {
        const bytes = await blobBytes(artifactDirectory(store), file.hash);
        const text = bytes.toString("utf8");
        if (possibleSecret(file.path, text) || (await privateCheck?.(`${file.path}\n${text}`)))
          throw Error("artifact_held_possible_secret");
      }
    }
    const readmeInfo = await lstat(path.join(root, ".zoltbot/README.md")).catch((e) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (
      readmeInfo &&
      (!readmeInfo.isFile() || readmeInfo.isSymbolicLink() || readmeInfo.nlink !== 1)
    )
      throw Error("artifact_repository_file_denied");
    const base = await repositoryDirectory(root, `.zoltbot/artifacts/${artifact.key}`);
    await cleanupRepositoryTemps(base);
    const previous = await existingRepositoryJson(base, "artifact.json");
    const materialize = async (manifest: ArtifactManifest, directory: string) => {
      for (const file of manifest.files) {
        if (file.bytes > repositoryFileLimit) continue;
        const bytes = await blobBytes(artifactDirectory(store), file.hash);
        if (bytes.length !== file.bytes) throw Error("artifact_blob_corrupt");
        await atomicRepositoryFile(directory, file.path, bytes);
      }
    };
    await replaceRepositoryFolder(base, "current", (d) => materialize(detail.manifest, d));
    const starred = [];
    for (const star of starredVersions) {
      starred.push(star.manifestHash);
      await replaceRepositoryFolder(base, star.manifestHash, (d) =>
        materialize(versionDetail(store, star.id).manifest, d),
      );
    }
    const record = {
      format: 1,
      number: version.number,
      manifestHash: version.manifestHash,
      manifest: detail.manifest,
      note: version.note,
      by: producers.get(version.id),
      at: version.createdAt,
    };
    const relative = `versions/${version.number}-${version.manifestHash.slice(0, 16)}-${contentHash(JSON.stringify(record))}.json`;
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    await atomicRepositoryFile(base, relative, bytes, true);
    const missingFiles = detail.manifest.files
      .filter((f) => f.bytes > repositoryFileLimit)
      .map((f) => f.path);
    await atomicRepositoryFile(
      base,
      "artifact.json",
      Buffer.from(
        `${JSON.stringify(
          {
            format: 1,
            key: artifact.key,
            kind: artifact.kind,
            title: artifact.title,
            currentManifestHash: version.manifestHash,
            starredHashes: starred,
            missingFiles,
          },
          null,
          2,
        )}\n`,
      ),
    );
    const readme = ".zoltbot/README.md";
    const existing = await existingRepositoryJson(base, "artifact.json");
    if (!existing) throw Error("artifact_repository_write_failed");
    const readmePath = path.join(root, readme),
      info = await lstat(readmePath).catch((e) => {
        if (e.code === "ENOENT") return undefined;
        throw e;
      });
    if (!info)
      await atomicRepositoryFile(
        root,
        readme,
        Buffer.from(
          "This folder contains Zoltbot artifact source bundles and version records. It is safe to commit reviewed artifacts; comments, private history and caches stay on the Mac. Files larger than 1 MiB are recorded but stay on the producing Mac.\n",
        ),
      );
    else if (!info.isFile() || info.isSymbolicLink())
      throw Error("artifact_repository_file_denied");
    if (Array.isArray(previous?.starredHashes))
      for (const hash of previous.starredHashes) {
        if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) && !starred.includes(hash))
          await rm(path.join(base, hash), { recursive: true, force: true });
      }
    store.database
      .prepare(
        "INSERT INTO artifact_repository_records_aux(project_id,root,path,artifact_id,version_id,source_hash) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,root,path) DO UPDATE SET version_id=excluded.version_id,source_hash=excluded.source_hash",
      )
      .run(
        artifact.projectId ?? artifact.threadId,
        root,
        `${artifact.key}/${relative}`,
        artifact.id,
        version.id,
        contentHash(bytes.toString("utf8")),
      );
    return { root, partial: missingFiles.length > 0, missingFiles };
  });
}
export async function materializeTaskArtifacts(
  store: Store,
  taskId: string,
  revision: number,
  options: {
    privateCheck?: (text: string) => Promise<boolean>;
    publish?: (events: import("@zoltbot/protocol").DomainEvent[]) => void;
  } = {},
) {
  const task = store.record("task", taskId);
  const workspace = task?.workspaceId
    ? store.record("workspace", String(task.workspaceId))
    : undefined;
  const project = task?.projectId ? store.record("project", String(task.projectId)) : undefined;
  if (workspace?.kind !== "worktree" && project?.artifactRepositoryMode === "off") return;
  for (const ref of taskArtifactVersions(store, taskId, revision)) {
    const version: ArtifactVersion = artifactVersion(store, ref.versionId);
    if (version.held || !ref.repositoryRoot) continue;
    try {
      const written = await writeRepositoryVersion(
        store,
        ref.artifactId,
        version.id,
        false,
        ref.repositoryRoot,
        options.privateCheck,
      );
      const commandId = `artifact-written:${contentHash(JSON.stringify([taskId, revision, version.id]))}`,
        before = store.lastSeq();
      store.dispatch(commandId, () => {
        const artifact = artifactRecord(store, ref.artifactId);
        return {
          events:
            artifact.currentVersionId === version.id
              ? [
                  artifactEvent(
                    "artifact",
                    {
                      ...artifact,
                      repositoryState: written.partial ? "partial" : "written",
                      updatedAt: new Date().toISOString(),
                    },
                    commandId,
                    0,
                    false,
                  ),
                ]
              : [],
          result: { root: written.root },
        };
      });
      options.publish?.(store.eventsSince(before));
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "artifact_held_possible_secret")
        throw error;
      const commandId = `artifact-held:${contentHash(JSON.stringify([taskId, revision, version.id]))}`,
        before = store.lastSeq();
      store.dispatch(commandId, () => {
        store.database
          .prepare("UPDATE artifact_manifests_aux SET visible_text='' WHERE version_id=?")
          .run(version.id);
        const artifact = artifactRecord(store, ref.artifactId);
        return {
          events:
            artifact.currentVersionId === version.id
              ? [
                  artifactEvent(
                    "artifact",
                    {
                      ...artifact,
                      repositoryState: "held_secret",
                      updatedAt: new Date().toISOString(),
                    },
                    commandId,
                    0,
                    false,
                  ),
                ]
              : [],
          result: { held: true },
        };
      });
      options.publish?.(store.eventsSince(before));
    }
  }
}
