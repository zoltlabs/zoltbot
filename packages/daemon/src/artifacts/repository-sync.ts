import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { artifactEvent, artifactRecord, contentHash } from "./model.js";
import { writeRepositoryVersion } from "./repository-write.js";
export function artifactRepositorySync(
  store: Store,
  options: {
    publish(events: DomainEvent[]): void;
    privateCheck(text: string): Promise<boolean>;
    pollMs?: number;
  },
) {
  let active: Promise<void> | undefined,
    closed = false;
  const work = () =>
    (active ??= (async () => {
      const jobs = store.database
        .prepare(
          "SELECT command_id,artifact_id,version_id,root FROM artifact_repository_writes_aux WHERE state='pending' ORDER BY rowid LIMIT 20",
        )
        .all() as { command_id: string; artifact_id: string; version_id: string; root: string }[];
      for (const job of jobs) {
        if (closed) break;
        const artifact = artifactRecord(store, job.artifact_id);
        const project = artifact.projectId
          ? store.record("project", artifact.projectId)
          : undefined;
        let state = "done",
          code: string | null = null,
          repositoryState = artifact.repositoryState;
        if (
          project?.artifactRepositoryMode !== "every_save" ||
          artifact.currentVersionId !== job.version_id
        )
          state = "superseded";
        else
          try {
            const result = await writeRepositoryVersion(
              store,
              artifact.id,
              job.version_id,
              false,
              job.root,
              options.privateCheck,
            );
            repositoryState = result.partial ? "partial" : "written";
          } catch (error) {
            state = "failed";
            code =
              error instanceof Error && error.message.startsWith("artifact_")
                ? error.message
                : "artifact_repository_write_failed";
            repositoryState = code === "artifact_held_possible_secret" ? "held_secret" : "pending";
          }
        const commandId = `repository-sync:${contentHash(job.command_id)}`,
          before = store.lastSeq();
        store.dispatch(commandId, () => {
          if (repositoryState === "held_secret")
            store.database
              .prepare("UPDATE artifact_manifests_aux SET visible_text='' WHERE version_id=?")
              .run(job.version_id);
          store.database
            .prepare("UPDATE artifact_repository_writes_aux SET state=?,code=? WHERE command_id=?")
            .run(state, code, job.command_id);
          const latest = artifactRecord(store, artifact.id);
          return {
            events:
              latest.currentVersionId === job.version_id
                ? [
                    artifactEvent(
                      "artifact",
                      { ...latest, repositoryState, updatedAt: new Date().toISOString() },
                      commandId,
                      0,
                      false,
                    ),
                  ]
                : [],
            result: { state },
          };
        });
        options.publish(store.eventsSince(before));
      }
    })().finally(() => {
      active = undefined;
    }));
  const timer = setInterval(() => {
    void work().catch(() => {});
  }, options.pollMs ?? 500);
  timer.unref();
  return {
    work,
    async close() {
      closed = true;
      clearInterval(timer);
      await active;
    },
  };
}
