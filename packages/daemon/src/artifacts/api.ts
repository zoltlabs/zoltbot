import { handle } from "@zoltbot/core";
import { repositoryLock } from "../../../gitkit/src/git.js";
import type { RuntimeContext } from "../api.js";
import { artifactDesigner } from "./designer.js";
import {
  artifactEvent,
  artifactPage,
  artifactRecord,
  artifactVersion,
  contentHash,
  versionDetail,
} from "./model.js";
import { queuedPhonePreview } from "./phone-preview.js";
import { indexArtifactRepository } from "./repository-index.js";
import { writeRepositoryVersion } from "./repository-write.js";
export function artifactsApi(context: RuntimeContext) {
  return async (method: string, params: Record<string, unknown>, commandId?: string) => {
    if (method.startsWith("deliverable.")) throw Error("deliverable_api_retired_use_artifact");
    if (!method.startsWith("artifact.")) return undefined;
    if (method === "artifact.designer") {
      if (!commandId) throw Error("command_id_required");
      return artifactDesigner(
        context,
        typeof params.projectId === "string" ? params.projectId : undefined,
        commandId,
      );
    }
    if (method === "artifact.list") {
      const items = artifactPage(context.store, params as Parameters<typeof artifactPage>[1]);
      const issues =
        typeof params.projectId === "string"
          ? context.store.database
              .prepare(
                `SELECT key,code FROM artifact_repository_issues_aux WHERE project_id=?
                UNION ALL SELECT a.key,w.code FROM artifact_repository_writes_aux w
                JOIN artifacts a ON a.id=w.artifact_id WHERE a.project_id=? AND w.state='failed' LIMIT 100`,
              )
              .all(params.projectId, params.projectId)
          : [];
      return { items, cursor: items.at(-1)?.id ?? null, issues };
    }
    if (method === "artifact.repository.index") {
      if (!commandId) throw Error("command_id_required");
      const replay = context.store.receipt(commandId);
      if (replay) return replay.result;
      const project = context.store.record("project", String(params.projectId));
      if (!project || project.archived) throw Error("project_unavailable");
      const roots = project.roots as { path: string }[];
      const results: Awaited<ReturnType<typeof indexArtifactRepository>>[] = [];
      for (const root of roots)
        results.push(
          await indexArtifactRepository(context, String(project.id), root.path, commandId),
        );
      return context.store.dispatch(commandId, () => ({ events: [], result: { results } })).result;
    }
    if (method === "artifact.phonePreview")
      return queuedPhonePreview(context.store, String(params.id), String(params.versionId));
    const artifact = artifactRecord(context.store, String(params.id));
    if (method === "artifact.versions")
      return {
        items: (context.store.snapshot(["artifactVersion"]).artifactVersion ?? [])
          .filter((v) => v.artifactId === artifact.id)
          .sort((a, b) => Number(b.number) - Number(a.number))
          .slice(0, 25),
      };
    if (method === "artifact.get") {
      const version = artifactVersion(
        context.store,
        typeof params.versionId === "string" ? params.versionId : artifact.currentVersionId,
      );
      if (version.artifactId !== artifact.id) throw Error("artifact_version_scope_denied");
      return version.metadataOnly
        ? { artifact, version, manifest: null, saveChecks: ["Files not in repository"] }
        : { artifact, version, ...versionDetail(context.store, version.id) };
    }
    if (!commandId) throw Error("command_id_required");
    return repositoryLock(`artifact-command:${commandId}`, async () => {
      const digest = contentHash(JSON.stringify([method, params]));
      const replay = context.store.receipt<{ digest: string; value: unknown }>(commandId);
      if (replay) {
        if (replay.result.digest !== digest) throw Error("command_receipt_conflict");
        return replay.result.value;
      }
      const guard = await context.privacy.prepareData(params);
      const at = new Date().toISOString();
      let next = { ...artifact, updatedAt: at };
      let value: unknown = { ok: true };
      if (method === "artifact.archive") next = { ...next, state: "archived" };
      else if (method === "artifact.add_to_repository") {
        const version = artifactVersion(context.store, String(params.versionId));
        if (version.artifactId !== artifact.id) throw Error("artifact_version_scope_denied");
        try {
          const result = await writeRepositoryVersion(
            context.store,
            artifact.id,
            version.id,
            params.allowHeld === true,
            undefined,
            async (text) => {
              try {
                await context.privacy.prepareData(text);
                return false;
              } catch {
                return true;
              }
            },
          );
          value = result;
          if (artifact.currentVersionId === version.id)
            next = { ...next, repositoryState: result.partial ? "partial" : "written" };
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "artifact_held_possible_secret")
            throw error;
          next = { ...next, repositoryState: "held_secret" };
          value = { held: true };
        }
      } else throw Error("artifact_method_unavailable");
      const before = context.store.lastSeq();
      const result = context.store.dispatch(commandId, (state) => {
        guard(state);
        if (next.repositoryState === "held_secret")
          context.store.database
            .prepare("UPDATE artifact_manifests_aux SET visible_text='' WHERE version_id=?")
            .run(String(params.versionId));
        const audit = handle(
          state,
          {
            type: "create",
            kind: "audit",
            value: {
              id: `audit-${contentHash(commandId)}`,
              actor: { kind: "human", id: "local-owner" },
              action: method,
              target: artifact.id,
              result: next.repositoryState === "held_secret" ? "held" : "done",
              detail: { versionId: params.versionId ?? null },
              at,
            },
          },
          { commandId: `${commandId}:audit`, at, actor: { kind: "human", id: "local-owner" } },
        );
        return {
          events: [
            artifactEvent(
              "artifact",
              {
                ...artifactRecord(context.store, artifact.id),
                updatedAt: at,
                ...(method === "artifact.archive"
                  ? { state: "archived" }
                  : artifactRecord(context.store, artifact.id).currentVersionId === params.versionId
                    ? { repositoryState: next.repositoryState }
                    : {}),
              },
              commandId,
              0,
              false,
            ),
            ...audit.events,
          ],
          result: { digest, value },
        };
      });
      context.publish(context.store.eventsSince(before));
      return result.result.value;
    });
  };
}
