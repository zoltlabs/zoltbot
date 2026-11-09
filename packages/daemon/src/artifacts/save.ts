import { randomUUID } from "node:crypto";
import type { ToolActor, ToolInvocation } from "@zoltbot/hostmcp";
import {
  type Artifact,
  type ArtifactBinding,
  ArtifactKeySchema,
  ArtifactKindSchema,
  type ArtifactManifest,
  ArtifactManifestSchema,
  type ArtifactVersion,
  parse,
} from "@zoltbot/protocol";
import type { RuntimeContext } from "../api.js";
import type { PublicWriteCheck } from "../private-input.js";
import { importFiles, possibleSecret } from "./intake.js";
import {
  artifactDirectory,
  artifactEvent,
  artifactRecord,
  artifactVersion,
  contentHash,
  validateManifest,
} from "./model.js";
import { revisionBase } from "./revision-target.js";
import { cleanupStaging, stagedFiles } from "./staging.js";
export function artifactOwner(context: RuntimeContext, actor: ToolActor) {
  const store = context.store;
  const thread = store.record("thread", actor.threadId),
    session = store.record("session", actor.sessionId),
    turn = actor.turnId ? store.record("turn", actor.turnId) : undefined;
  if (
    !thread ||
    thread.archived ||
    thread.agentId !== actor.agentId ||
    session?.threadId !== actor.threadId ||
    session.state !== "running" ||
    turn?.sessionId !== actor.sessionId ||
    turn.status !== "running"
  )
    throw Error("artifact_authority_denied");
  if (!store.record("agent", actor.agentId) || store.record("agent", actor.agentId)?.archived)
    throw Error("artifact_authority_denied");
  const configuration = store.record("settings", `runtime.configuration.${actor.sessionId}`)
    ?.value as { launchManifest?: { artifact?: ArtifactBinding } } | undefined;
  const binding = configuration?.launchManifest?.artifact;
  if (!binding || binding.toolsVersion !== 2) throw Error("artifact_not_enabled_at_launch");
  return { thread, binding, session };
}
interface SaveArgs {
  key: string;
  title: string;
  kind: Artifact["kind"];
  source: { dir?: string; files?: { path: string; text?: string; base64?: string }[] };
  entry?: string;
  screens?: ArtifactManifest["screens"];
  note?: string;
  kit?: "v1";
}
async function* inlineFiles(files: NonNullable<SaveArgs["source"]["files"]>) {
  if (!Array.isArray(files)) throw Error("artifact_source_required");
  for (const file of files) {
    if (
      typeof file.path !== "string" ||
      (typeof file.text === "string") === (typeof file.base64 === "string")
    )
      throw Error("invalid_artifact_inline");
    if (
      file.base64 &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)
    )
      throw Error("invalid_artifact_base64");
    yield {
      path: file.path,
      bytes:
        file.text !== undefined ? Buffer.from(file.text) : Buffer.from(file.base64 ?? "", "base64"),
    };
  }
}
export async function saveArtifact(context: RuntimeContext, call: ToolInvocation) {
  const owner = artifactOwner(context, call.actor);
  let args = call.arguments as SaveArgs;
  parse(ArtifactKeySchema, args.key);
  parse(ArtifactKindSchema, args.kind);
  if (
    typeof args.title !== "string" ||
    !args.title.trim() ||
    args.title.length > 200 ||
    (args.note?.length ?? 0) > 1000
  )
    throw Error("invalid_artifact_metadata");
  if (["external", "code_change"].includes(args.kind))
    throw Error("artifact_reference_requires_human_route");
  const commandId = `artifact-save:${contentHash(JSON.stringify([call.actor.sessionId, call.actor.turnId, call.idempotencyKey]))}`;
  const requestHash = contentHash(JSON.stringify(call.arguments));
  const replay = context.store.receipt<Record<string, unknown>>(commandId);
  if (replay) {
    if (replay.result.requestHash !== requestHash) throw Error("command_receipt_conflict");
    return replay.result.value;
  }
  let metadataHeld = possibleSecret(
    "",
    JSON.stringify({ key: args.key, title: args.title, note: args.note ?? "" }),
  );
  let publicCheck: PublicWriteCheck = () => {
    throw Error("artifact_metadata_unchecked");
  };
  try {
    if (!metadataHeld) {
      try {
        publicCheck = await context.privacy.prepareData({
          key: args.key,
          title: args.title,
          note: args.note ?? "",
        });
      } catch {
        metadataHeld = true;
      }
    }
    if (metadataHeld) {
      let keyHeld = possibleSecret("", args.key);
      try {
        await context.privacy.prepareData(args.key);
      } catch {
        keyHeld = true;
      }
      args = {
        ...args,
        key: keyHeld ? `held-${contentHash(args.key).slice(0, 32)}` : args.key,
        title: "Held artifact",
        note: "",
      };
      publicCheck = await context.privacy.prepareData({
        key: args.key,
        title: args.title,
        note: "",
      });
    }
  } catch (error) {
    await cleanupStaging(owner.binding);
    throw error;
  }

  const scope =
    typeof owner.thread.projectId === "string" ? owner.thread.projectId : call.actor.threadId;
  const artifactId = `artifact-${contentHash(JSON.stringify([owner.thread.projectId ? "project" : "thread", scope, args.key]))}`;
  let imported: Awaited<ReturnType<typeof importFiles>>;
  const privateChecks: PublicWriteCheck[] = [];
  try {
    if (!args.source || (typeof args.source.dir === "string") === Array.isArray(args.source.files))
      throw Error("artifact_source_required");
    if (args.source.files && Buffer.byteLength(JSON.stringify(args.source.files)) > 48 * 1024)
      throw Error("artifact_inline_limit");
    imported = await importFiles(
      artifactDirectory(context.store),
      args.source.dir
        ? stagedFiles(owner.binding, args.source.dir)
        : inlineFiles(args.source.files ?? []),
      async (text) => {
        try {
          privateChecks.push(await context.privacy.prepareData(text));
          return false;
        } catch {
          return true;
        }
      },
    );
  } finally {
    await cleanupStaging(owner.binding);
  }
  artifactOwner(context, call.actor); // Async intake never extends native session authority.
  const manifest = parse(ArtifactManifestSchema, {
    version: 1,
    ...(args.kit === "v1" ? { kit: "v1" } : {}),
    entry:
      args.entry ??
      args.screens?.[0]?.path ??
      imported.files.find((f) => f.path === "index.html")?.path ??
      imported.files[0]?.path,
    files: imported.files,
    screens: (args.screens ?? []).map(({ id, title, path, width, height }) => ({
      id,
      title,
      path,
      width,
      height,
    })),
  });
  validateManifest(manifest);
  imported.held ||= metadataHeld || possibleSecret("", JSON.stringify(manifest.screens));
  try {
    privateChecks.push(await context.privacy.prepareData(manifest));
  } catch {
    imported.held = true;
  }
  const manifestHash = contentHash(JSON.stringify(manifest));
  const checks = [
    ...(imported.held ? ["Held: possible secret"] : []),
    ...(imported.external ? ["External resources will not load"] : []),
  ];
  const task = owner.thread.taskId
    ? context.store.record("task", String(owner.thread.taskId))
    : undefined;
  const recordSave = (versionId: string) => {
    context.store.database
      .prepare(
        "INSERT INTO artifact_saves_aux(command_id,task_id,revision,artifact_id,version_id,repository_root,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        commandId,
        task?.id ?? null,
        task?.revision ?? null,
        artifactId,
        versionId,
        owner.binding.repositoryRoot ?? null,
        new Date().toISOString(),
      );
    const project =
      typeof owner.thread.projectId === "string"
        ? context.store.record("project", owner.thread.projectId)
        : undefined;
    if (
      project?.artifactRepositoryMode === "every_save" &&
      task?.workspaceMode !== "worktree" &&
      owner.binding.repositoryRoot &&
      !imported.held
    )
      context.store.database
        .prepare(
          "INSERT INTO artifact_repository_writes_aux(command_id,artifact_id,version_id,root,state,created_at) VALUES(?,?,?,?,'pending',?)",
        )
        .run(
          commandId,
          artifactId,
          versionId,
          owner.binding.repositoryRoot,
          new Date().toISOString(),
        );
  };
  const before = context.store.lastSeq();
  const receipt = context.store.dispatch<Record<string, unknown>>(commandId, (state) => {
    publicCheck(state);
    for (const check of privateChecks) {
      try {
        check(state);
      } catch {
        imported.held = true;
      }
    }
    if (imported.held && !checks.includes("Held: possible secret"))
      checks.unshift("Held: possible secret");
    artifactOwner(context, call.actor);
    const priorRow = state.artifact?.find((r) => r.id === artifactId);
    const prior = priorRow ? artifactRecord(context.store, artifactId) : undefined;
    if (prior) {
      const current = artifactVersion(context.store, prior.currentVersionId);
      if (current.manifestHash === manifestHash) {
        recordSave(current.id);
        if (imported.held)
          context.store.database
            .prepare("UPDATE artifact_manifests_aux SET visible_text='' WHERE version_id=?")
            .run(current.id);
        return {
          events: imported.held
            ? [
                artifactEvent(
                  "artifact",
                  { ...prior, repositoryState: "held_secret", updatedAt: new Date().toISOString() },
                  commandId,
                  0,
                  false,
                ),
              ]
            : [],
          result: {
            requestHash,
            value: {
              artifactId,
              versionId: current.id,
              number: current.number,
              held: current.held || imported.held,
              viewer: `#artifact/${artifactId}`,
              unchanged: true,
            },
          },
        };
      }
    }
    const at = new Date().toISOString();
    const versionId = `version-${randomUUID()}`;
    const number =
      Math.max(
        0,
        ...(state.artifactVersion ?? [])
          .filter((r) => r.artifactId === artifactId)
          .map((r) => Number(r.number)),
      ) + 1;
    const baseVersionId = revisionBase(context.store, String(call.actor.turnId), artifactId);
    const version: ArtifactVersion = {
      id: versionId,
      artifactId,
      number,
      manifestHash,
      totalBytes: imported.totalBytes,
      fileCount: imported.files.length,
      ...(owner.binding.repositoryRoot ? { repositoryRoot: owner.binding.repositoryRoot } : {}),
      producedBy: {
        provider: String(owner.session.provider ?? "unknown"),
        profile: String(context.store.record("agent", call.actor.agentId)?.name ?? "Agent"),
      },
      sessionId: call.actor.sessionId,
      turnId: String(call.actor.turnId),
      ...(baseVersionId ? { baseVersionId } : {}),
      ...(task ? { taskId: String(task.id), taskRevision: Number(task.revision) } : {}),
      note: args.note ?? "",
      auto: false,
      held: imported.held,
      metadataOnly: false,
      thumbnailState: "pending",
      thumbnails: {},
      reviewState: "unreviewed",
      createdAt: at,
    };
    const artifact: Artifact = {
      id: artifactId,
      ...(typeof owner.thread.projectId === "string" ? { projectId: owner.thread.projectId } : {}),
      threadId: prior?.threadId ?? call.actor.threadId,
      ...(prior?.taskId ? { taskId: prior.taskId } : task ? { taskId: String(task.id) } : {}),
      key: args.key,
      kind: args.kind,
      title: args.title,
      currentVersionId: versionId,
      starredVersionIds: prior?.starredVersionIds ?? [],
      profileId: prior?.profileId ?? call.actor.agentId,
      provider: prior?.provider ?? String(owner.session.provider ?? "unknown"),
      state: "active",
      ...(owner.binding.repositoryRoot ? { repositoryRoot: owner.binding.repositoryRoot } : {}),
      repositoryState: imported.held
        ? "held_secret"
        : owner.binding.repositoryRoot
          ? "pending"
          : "local",
      createdAt: prior?.createdAt ?? at,
      updatedAt: at,
    };
    for (const file of manifest.files)
      context.store.database
        .prepare(
          "INSERT INTO artifact_blob_types_aux(hash,mime,bytes,created_at) VALUES(?,?,?,?) ON CONFLICT(hash,mime) DO NOTHING",
        )
        .run(file.hash, file.mime, file.bytes, at);
    context.store.database
      .prepare(
        "INSERT INTO artifact_manifests_aux(version_id,manifest,save_checks,visible_text) VALUES(?,?,?,?)",
      )
      .run(
        versionId,
        JSON.stringify(manifest),
        JSON.stringify(checks),
        imported.held ? "" : imported.text.slice(0, 16000),
      );
    recordSave(versionId);
    return {
      events: [
        artifactEvent("artifactVersion", version, commandId, 0, true),
        artifactEvent("artifact", artifact, commandId, 1, !prior),
      ],
      result: {
        requestHash,
        value: {
          artifactId,
          versionId,
          number,
          held: imported.held,
          viewer: `#artifact/${artifactId}`,
          checks,
        },
      },
    };
  });
  context.publish(context.store.eventsSince(before));
  return receipt.result.value;
}
