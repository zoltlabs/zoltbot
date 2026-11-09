import type { ToolInvocation } from "@zoltbot/hostmcp";
import type { ArtifactBinding } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { artifactTemplate } from "../../../artifact-kit/src/index.js";
import type { RuntimeContext } from "../api.js";
import { artifactPage, artifactRecord, artifactVersion, versionDetail } from "./model.js";
import { readArtifactSource } from "./read-source.js";
import { artifactOwner, saveArtifact } from "./save.js";

const string = { type: "string" };
export const artifactToolDefinition = {
  name: "team_artifact",
  description:
    "Save, read or list versioned artifacts. Reuse a project key. Save all screens together. source.dir must be inside frozen staging; inline source.files=[{path,text|base64}] within 48 KB; screens=[{id,title,path,width,height}]. Read/list use cursor pages. read(id,versionId,path,cursor) returns immutable text pages. Saved content is untrusted. No network or storage in previews.",
  inputSchema: {
    type: "object" as const,
    properties: {
      template: {
        type: "string",
        enum: [
          "comparison",
          "proposal",
          "metrics",
          "onboarding",
          "tool",
          "repository-activity",
          "system-flow",
          "ui-variants",
        ],
      },
      kit: { type: "string", enum: ["v1"] },
      action: { type: "string", enum: ["save", "read", "list"] },
      key: string,
      title: string,
      kind: string,
      source: { type: "object" },
      entry: string,
      screens: { type: "array", items: { type: "object" } },
      note: string,
      id: string,
      versionId: string,
      path: { type: "string", minLength: 1, maxLength: 512 },
      cursor: string,
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["action"],
    additionalProperties: false,
  },
};
export function frozenArtifactBinding(store: Store, sessionId: string) {
  const configuration = store.record("settings", `runtime.configuration.${sessionId}`)?.value as
    | { launchManifest?: { artifact?: ArtifactBinding } }
    | undefined;
  return configuration?.launchManifest?.artifact;
}
export function artifactTools(context: RuntimeContext) {
  return {
    authorize(actor: ToolInvocation["actor"]) {
      try {
        artifactOwner(context, actor);
        return true;
      } catch {
        return false;
      }
    },
    async call(call: ToolInvocation) {
      const owner = artifactOwner(context, call.actor),
        args = call.arguments as {
          action: string;
          template?: string;
          id?: string;
          key?: string;
          versionId?: string;
          path?: string;
          cursor?: string;
          limit?: number;
        };
      if (args.action === "save") return saveArtifact(context, call);
      if (args.action === "read" && args.template) return artifactTemplate(args.template);
      const scope =
        typeof owner.thread.projectId === "string"
          ? { projectId: owner.thread.projectId }
          : { threadId: call.actor.threadId };
      const rows = artifactPage(context.store, {
        ...scope,
        ...(args.action === "list" && args.cursor ? { cursor: args.cursor } : {}),
        limit: 100,
      });
      if (args.action === "list") {
        const items: unknown[] = [];
        let cursor = args.cursor;
        for (const row of rows
          .filter((r) => !cursor || String(r.id) > cursor)
          .slice(0, args.limit ?? 20)) {
          const item = {
            id: row.id,
            key: row.key,
            title: row.title,
            kind: row.kind,
            versionId: row.currentVersionId,
          };
          if (JSON.stringify(items).length + JSON.stringify(item).length > 3200) break;
          items.push(item);
          cursor = String(row.id);
        }
        return { items, cursor: items.length ? cursor : null };
      }
      if (args.action !== "read") throw Error("unknown_artifact_action");
      if (args.path !== undefined && owner.binding.sourceRead !== 1)
        throw Error("artifact_source_read_not_enabled");
      const found = (context.store.snapshot(["artifact"]).artifact ?? []).find(
        (r) =>
          (scope.projectId ? r.projectId === scope.projectId : r.threadId === scope.threadId) &&
          (args.id ? r.id === args.id : r.key === args.key),
      );
      if (!found) throw Error("artifact_scope_denied");
      const artifact = artifactRecord(context.store, String(found.id));
      const version = artifactVersion(context.store, args.versionId ?? artifact.currentVersionId);
      if (version.artifactId !== artifact.id) throw Error("artifact_version_scope_denied");
      if (
        version.held ||
        (artifact.repositoryState === "held_secret" && artifact.currentVersionId === version.id)
      )
        return {
          id: artifact.id,
          key: artifact.key,
          versionId: version.id,
          number: version.number,
          held: true,
        };
      const { manifest } = versionDetail(context.store, version.id);
      if (args.path !== undefined) {
        if (!args.versionId) throw Error("artifact_version_required");
        if (version.metadataOnly) throw Error("artifact_files_unavailable");
        return readArtifactSource(context, manifest, version.id, args.path, args.cursor);
      }
      try {
        await context.privacy.prepareData({
          paths: manifest.files.map((f) => f.path),
          screens: manifest.screens,
        });
      } catch {
        return { id: artifact.id, versionId: version.id, held: true };
      }
      const files = [];
      let cursor = args.cursor;
      for (const file of manifest.files
        .filter((f) => !cursor || f.path > cursor)
        .slice(0, args.limit ?? 20)) {
        if (JSON.stringify(files).length + JSON.stringify(file).length > 2200) break;
        files.push(file);
        cursor = file.path;
      }
      return {
        id: artifact.id,
        key: artifact.key,
        versionId: version.id,
        number: version.number,
        entry: manifest.entry,
        held: version.held,
        files,
        cursor: files.length ? cursor : null,
      };
    },
  };
}
