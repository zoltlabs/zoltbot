import { lstat } from "node:fs/promises";
import path from "node:path";
import { type Artifact, ArtifactKeySchema, type ArtifactVersion, parse } from "@zoltbot/protocol";
import type { RuntimeContext } from "../api.js";
import type { PublicWriteCheck } from "../private-input.js";
import { artifactPath, checkedAncestors, importFiles, possibleSecret, safeFile } from "./intake.js";
import {
  artifactDirectory,
  artifactEvent,
  artifactRecord,
  artifactVersion,
  contentHash,
  validateManifest,
} from "./model.js";
import { boundedRepositoryEntries } from "./repository-files.js";
import {
  parseRepositoryArtifact,
  parseRepositoryVersion,
  repositoryJson,
} from "./repository-format.js";

export async function indexArtifactRepository(
  context: RuntimeContext,
  projectId: string,
  root: string,
  commandPrefix = "repository-index",
) {
  const store = context.store;
  const base = path.join(root, ".zoltbot", "artifacts");
  try {
    await checkedAncestors(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { indexed: 0, issues: [] };
    throw error;
  }
  const entries = await boundedRepositoryEntries(base, 1000);
  if (entries.length > 1000) throw Error("artifact_repository_index_limit");
  let indexed = 0;
  const issues: { key: string; code: string }[] = [];
  for (const entry of entries) {
    let issueKey = `folder-${contentHash(entry.name).slice(0, 16)}`;
    try {
      parse(ArtifactKeySchema, entry.name);
      await context.privacy.prepareData(entry.name);
      if (!possibleSecret("", entry.name)) issueKey = entry.name;
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw Error("artifact_repository_directory_denied");
      const folder = path.join(base, entry.name);
      const descriptor = parseRepositoryArtifact(await repositoryJson(folder, "artifact.json"));
      if (descriptor.key !== entry.name) throw Error("artifact_repository_key_mismatch");
      if (possibleSecret("", JSON.stringify(descriptor)))
        throw Error("artifact_repository_private_metadata");
      const guard = await context.privacy.prepareData(descriptor);
      const versionsFolder = path.join(folder, "versions");
      await checkedAncestors(versionsFolder);
      const files = await boundedRepositoryEntries(versionsFolder, 10000);
      if (files.length > 10000) throw Error("artifact_repository_version_limit");
      const records = [];
      for (const file of files) {
        if (!file.isFile() || file.isSymbolicLink() || !/^\d+-[a-f0-9-]+\.json$/.test(file.name))
          throw Error("artifact_repository_version_file_denied");
        const record = parseRepositoryVersion(await repositoryJson(versionsFolder, file.name));
        validateManifest(record.manifest);
        for (const f of record.manifest.files) artifactPath(f.path);
        if (record.manifestHash !== contentHash(JSON.stringify(record.manifest)))
          throw Error("artifact_repository_manifest_hash");
        if (possibleSecret("", JSON.stringify({ note: record.note, by: record.by })))
          throw Error("artifact_repository_private_metadata");
        await context.privacy.prepareData({ note: record.note, by: record.by });
        records.push({
          file: file.name,
          at: record.at,
          sourceHash: contentHash(JSON.stringify(record)),
        });
      }
      records.sort((a, b) => a.at.localeCompare(b.at) || a.file.localeCompare(b.file));
      const artifactId = `artifact-${contentHash(JSON.stringify(["project", projectId, descriptor.key]))}`;
      const importedVersions: ArtifactVersion[] = [];
      for (const { file, sourceHash } of records) {
        const record = parseRepositoryVersion(await repositoryJson(versionsFolder, file));
        if (sourceHash !== contentHash(JSON.stringify(record)))
          throw Error("artifact_repository_metadata_changed");
        const recordGuard = await context.privacy.prepareData({ note: record.note, by: record.by });
        const known = (store.snapshot(["artifactVersion"]).artifactVersion ?? []).find(
          (v) =>
            v.artifactId === artifactId &&
            v.manifestHash === record.manifestHash &&
            v.createdAt === record.at,
        );
        const versionId = `version-${contentHash(JSON.stringify([artifactId, sourceHash]))}`;
        const cached = store.record("artifactVersion", versionId);
        const directory =
          record.manifestHash === descriptor.currentManifestHash
            ? "current"
            : descriptor.starredHashes.includes(record.manifestHash)
              ? record.manifestHash
              : undefined;
        let metadataOnly = !directory;
        const inputs: string[] = [];
        if (directory) {
          let present = true;
          try {
            await checkedAncestors(path.join(folder, directory));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              present = false;
              metadataOnly = true;
            } else throw error;
          }
          for (const expected of record.manifest.files) {
            if (!present) continue;
            const info = await lstat(path.join(folder, directory, expected.path)).catch((error) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            if (!info) {
              metadataOnly = true;
              continue;
            }
            if (info.isSymbolicLink() || !info.isFile() || info.size !== expected.bytes)
              throw Error("artifact_repository_file_size");
            inputs.push(expected.path);
          }
        }
        const privateChecks: PublicWriteCheck[] = [];
        let held = false,
          visible = "";
        if (inputs.length) {
          const result = await importFiles(
            artifactDirectory(store),
            (async function* () {
              for (const relative of inputs)
                yield {
                  path: relative,
                  bytes: await safeFile(path.join(folder, String(directory)), relative),
                };
            })(),
            async (text) => {
              try {
                privateChecks.push(await context.privacy.prepareData(text));
                return false;
              } catch {
                return true;
              }
            },
          );
          held = result.held;
          visible = result.text;
          for (const actual of result.files) {
            const expected = record.manifest.files.find((f) => f.path === actual.path);
            if (!expected || actual.hash !== expected.hash || actual.mime !== expected.mime)
              throw Error("artifact_repository_file_hash");
          }
        }
        if (known || cached) {
          const priorVersion = artifactVersion(store, String(known?.id ?? cached?.id));
          if (held || (priorVersion.metadataOnly && !metadataOnly)) {
            const commandId = `${commandPrefix}:availability:${contentHash(JSON.stringify([priorVersion.id, held, metadataOnly, store.lastSeq()]))}`,
              before = store.lastSeq();
            store.dispatch(commandId, (state) => {
              guard(state);
              recordGuard(state);
              for (const check of privateChecks) {
                try {
                  check(state);
                } catch {
                  held = true;
                }
              }
              const next = {
                ...priorVersion,
                held: priorVersion.held || held,
                metadataOnly: priorVersion.metadataOnly && metadataOnly,
              };
              store.database
                .prepare("UPDATE artifact_manifests_aux SET visible_text=? WHERE version_id=?")
                .run(next.held ? "" : visible, priorVersion.id);
              if (!next.metadataOnly)
                for (const f of record.manifest.files)
                  store.database
                    .prepare(
                      "INSERT INTO artifact_blob_types_aux(hash,mime,bytes,created_at) VALUES(?,?,?,?) ON CONFLICT(hash,mime) DO NOTHING",
                    )
                    .run(f.hash, f.mime, f.bytes, record.at);
              return {
                events: [artifactEvent("artifactVersion", next, commandId, 0, false)],
                result: {},
              };
            });
            context.publish(store.eventsSince(before));
          }
          importedVersions.push(artifactVersion(store, priorVersion.id));
          continue;
        }
        const before = store.lastSeq();
        const commandId = `${commandPrefix}:v:${contentHash(versionId)}`;
        const result = store.dispatch(commandId, (state) => {
          guard(state);
          recordGuard(state);
          for (const check of privateChecks) {
            try {
              check(state);
            } catch {
              held = true;
            }
          }
          const number =
            Math.max(
              0,
              ...(state.artifactVersion ?? [])
                .filter((v) => v.artifactId === artifactId)
                .map((v) => Number(v.number)),
            ) + 1;
          const version: ArtifactVersion = {
            id: versionId,
            artifactId,
            number,
            manifestHash: record.manifestHash,
            totalBytes: record.manifest.files.reduce((n, f) => n + f.bytes, 0),
            fileCount: record.manifest.files.length,
            producedBy: record.by,
            sessionId: "repository",
            turnId: "repository",
            repositoryRoot: root,
            note: record.note,
            auto: false,
            held,
            metadataOnly,
            thumbnailState: "pending",
            thumbnails: {},
            reviewState: "unreviewed",
            createdAt: record.at,
          };
          store.database
            .prepare(
              "INSERT INTO artifact_manifests_aux(version_id,manifest,save_checks,visible_text) VALUES(?,?,?,?)",
            )
            .run(
              versionId,
              JSON.stringify(record.manifest),
              JSON.stringify(
                metadataOnly ? ["Files not in repository"] : held ? ["Held: possible secret"] : [],
              ),
              held ? "" : visible,
            );
          if (!metadataOnly)
            for (const f of record.manifest.files)
              store.database
                .prepare(
                  "INSERT INTO artifact_blob_types_aux(hash,mime,bytes,created_at) VALUES(?,?,?,?) ON CONFLICT(hash,mime) DO NOTHING",
                )
                .run(f.hash, f.mime, f.bytes, record.at);
          store.database
            .prepare(
              "INSERT INTO artifact_repository_records_aux(project_id,root,path,artifact_id,version_id,source_hash) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,root,path) DO UPDATE SET version_id=excluded.version_id,source_hash=excluded.source_hash",
            )
            .run(
              projectId,
              root,
              `${descriptor.key}/versions/${file}`,
              artifactId,
              versionId,
              sourceHash,
            );
          return {
            events: [artifactEvent("artifactVersion", version, commandId, 0, true)],
            result: version,
          };
        });
        context.publish(store.eventsSince(before));
        importedVersions.push(result.result);
      }
      const current = importedVersions
        .filter((v) => v.manifestHash === descriptor.currentManifestHash)
        .at(-1);
      if (!current) throw Error("artifact_repository_current_missing");
      const prior = store.record("artifact", artifactId)
        ? artifactRecord(store, artifactId)
        : undefined;
      const keepLocal =
        prior?.repositoryState === "pending" &&
        artifactVersion(store, prior.currentVersionId).createdAt > current.createdAt;
      const at = new Date().toISOString(),
        commandId = `${commandPrefix}:i:${contentHash(JSON.stringify([artifactId, descriptor, store.lastSeq()]))}`;
      const artifact: Artifact = {
        id: artifactId,
        projectId,
        threadId: prior?.threadId ?? `repository-${projectId}`,
        key: descriptor.key,
        title: descriptor.title,
        kind: descriptor.kind,
        currentVersionId: keepLocal ? prior.currentVersionId : current.id,
        starredVersionIds: importedVersions
          .filter((v) => descriptor.starredHashes.includes(v.manifestHash))
          .map((v) => v.id),
        provider: prior?.provider ?? "repository",
        profileId: prior?.profileId ?? "repository",
        state: "active",
        repositoryRoot: root,
        repositoryState: keepLocal ? "pending" : current.held ? "held_secret" : "from_repository",
        createdAt: prior?.createdAt ?? importedVersions[0]?.createdAt ?? at,
        updatedAt: at,
      };
      const before = store.lastSeq();
      store.dispatch(commandId, (state) => {
        guard(state);
        return { events: [artifactEvent("artifact", artifact, commandId, 0, !prior)], result: {} };
      });
      store.database
        .prepare(
          "DELETE FROM artifact_repository_issues_aux WHERE project_id=? AND root=? AND key=?",
        )
        .run(projectId, root, issueKey);
      context.publish(store.eventsSince(before));
      indexed++;
    } catch (error) {
      const code =
        error instanceof Error && error.message.startsWith("artifact_")
          ? error.message
          : "artifact_repository_invalid";
      issues.push({ key: issueKey, code });
      const id = `artifact-${contentHash(JSON.stringify(["project", projectId, entry.name]))}`;
      const existing = store.record("artifact", id);
      if (existing) {
        const commandId = `${commandPrefix}:invalid:${contentHash(JSON.stringify([id, code, store.lastSeq()]))}`,
          before = store.lastSeq();
        store.dispatch(commandId, () => ({
          events: [
            artifactEvent(
              "artifact",
              { ...existing, state: "invalid_repository", updatedAt: new Date().toISOString() },
              commandId,
              0,
              false,
            ),
          ],
          result: {},
        }));
        context.publish(store.eventsSince(before));
      }
      store.database
        .prepare(
          "INSERT INTO artifact_repository_issues_aux(project_id,root,key,code) VALUES(?,?,?,?) ON CONFLICT(project_id,root,key) DO UPDATE SET code=excluded.code",
        )
        .run(projectId, root, issueKey, code);
    }
  }
  return { indexed, issues };
}
