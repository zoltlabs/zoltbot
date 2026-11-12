import { ProjectSchema, parse, TaskSchema } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store/portable";
import { CellCommands } from "./commands.js";
import type { CellService } from "./service.js";

interface Publication {
  task_id: string;
  revision: number;
  command_id: string;
  head: string;
  branch: string;
  repository: string;
  base_branch: string;
  previous_head: string | null;
  state: "pending" | "pushed" | "complete" | "failed";
  result: string | null;
  error_code: string | null;
}
/** Accepted heads commit with the human review; GitHub I/O runs later, outside that transaction. */
export class CellPublications {
  constructor(
    private readonly store: Store,
    private readonly service: Pick<CellService, "request">,
    private readonly orgId: string,
    private readonly memberId: string,
    private readonly isActive: () => boolean = () => true,
  ) {
    store.database.exec(
      "CREATE TABLE IF NOT EXISTS cell_publications(task_id TEXT NOT NULL,revision INTEGER NOT NULL,command_id TEXT NOT NULL UNIQUE,head TEXT NOT NULL,branch TEXT NOT NULL,repository TEXT NOT NULL,base_branch TEXT NOT NULL,previous_head TEXT,state TEXT NOT NULL,result TEXT,error_code TEXT,PRIMARY KEY(task_id,revision))",
    );
  }
  private task(taskId: string) {
    const task = parse(TaskSchema, this.store.record("task", taskId));
    if (task.createdBy.id !== this.memberId || !task.projectId) throw new Error("forbidden");
    const project = parse(ProjectSchema, this.store.record("project", task.projectId));
    if (!project.cloud || project.archived) throw new Error("forbidden");
    return { task, project, cloud: project.cloud };
  }
  get(taskId: string) {
    this.task(taskId);
    const row = this.store.database
      .prepare("SELECT * FROM cell_publications WHERE task_id=? ORDER BY revision DESC LIMIT 1")
      .get(taskId) as Publication | undefined;
    return row
      ? {
          taskId,
          revision: row.revision,
          head: row.head,
          branch: row.branch,
          repository: row.repository,
          state: row.state,
          ...(row.error_code ? { error: row.error_code } : {}),
          ...(row.result
            ? { pullRequest: JSON.parse(row.result) as { number: number; url: string } }
            : {}),
        }
      : undefined;
  }
  /** Call only inside the same Store.dispatch transaction that accepts the review. */
  enqueue(taskId: string, revision: number, head: string, branch: string, commandId: string) {
    const { task, cloud } = this.task(taskId);
    if (task.revision !== revision) throw new Error("stale_revision");
    if (task.state !== "review" || !/^[a-f0-9]{40}$/.test(head))
      throw new Error("review_changes_unavailable");
    const commands = new CellCommands(this.store);
    const snapshots = this.store.database
      .prepare(
        "SELECT r.command_id FROM cell_runner_command_results r JOIN cell_runner_commands c ON c.id=r.command_id WHERE r.task_id=? AND r.revision=? AND c.state='complete' ORDER BY r.rowid DESC LIMIT 4",
      )
      .all(taskId, revision) as { command_id: string }[];
    const reviewed = snapshots
      .map((row) => commands.collected(taskId, row.command_id))
      .find((entry) => entry?.state === "complete" && entry.result.head === head);
    if (
      reviewed?.state !== "complete" ||
      reviewed.result.patchIncomplete ||
      reviewed.result.status ||
      reviewed.result.uncommittedFiles.length
    )
      throw new Error("review_changes_unavailable");
    const prior = this.store.database
      .prepare(
        "SELECT branch,head,state FROM cell_publications WHERE task_id=? ORDER BY revision DESC LIMIT 1",
      )
      .get(taskId) as Pick<Publication, "branch" | "head" | "state"> | undefined;
    if (prior && prior.state !== "complete") throw new Error("publication_pending");
    const destination = prior?.branch ?? branch;
    commands.enqueue(taskId, commandId, {
      type: "push_branch",
      revision,
      head,
      branch: destination,
      ...(prior ? { previousHead: prior.head } : {}),
    });
    this.store.database
      .prepare(
        "INSERT INTO cell_publications(task_id,revision,command_id,head,branch,repository,base_branch,previous_head,state) VALUES(?,?,?,?,?,?,?,?,'pending')",
      )
      .run(
        taskId,
        revision,
        commandId,
        head,
        destination,
        cloud.repository,
        cloud.defaultBranch,
        prior?.head ?? null,
      );
  }
  private current(row: Publication) {
    if (!this.isActive()) return false;
    const { task, project } = this.task(row.task_id);
    return (
      task.revision === row.revision &&
      task.state === "completed" &&
      task.reviewState === "accept" &&
      project.cloud?.repository === row.repository &&
      project.cloud.defaultBranch === row.base_branch
    );
  }
  async tick() {
    const rows = this.store.database
      .prepare(
        "SELECT * FROM cell_publications WHERE state IN ('pending','pushed') ORDER BY rowid LIMIT 4",
      )
      .all() as Publication[];
    for (const row of rows) {
      if (!this.current(row)) {
        if (!this.isActive()) return;
        this.store.database
          .prepare(
            "UPDATE cell_publications SET state='failed',error_code='stale_revision' WHERE task_id=? AND revision=?",
          )
          .run(row.task_id, row.revision);
        continue;
      }
      const commands = new CellCommands(this.store);
      const proof = commands.published(row.task_id, row.command_id);
      if (proof?.state === "failed") {
        this.store.database
          .prepare(
            "UPDATE cell_publications SET state='failed',error_code='runner_command_failed' WHERE task_id=? AND revision=?",
          )
          .run(row.task_id, row.revision);
        continue;
      }
      if (proof?.state !== "complete") continue;
      if (
        proof.result.head !== row.head ||
        proof.result.branch !== row.branch ||
        proof.result.repository !== row.repository ||
        proof.result.revision !== row.revision
      )
        throw new Error("publication_proof_invalid");
      this.store.database
        .prepare(
          "UPDATE cell_publications SET state='pushed' WHERE task_id=? AND revision=? AND state='pending'",
        )
        .run(row.task_id, row.revision);
      try {
        const result = await this.service.request(
          "github/pull-request",
          "POST",
          {
            orgId: this.orgId,
            repository: row.repository,
            head: row.branch,
            base: row.base_branch,
            commit: row.head,
            title: "Zoltbot task changes",
            body: "",
          },
          { operationId: row.command_id, timeoutMs: 20000 },
        );
        if (!this.current(row)) continue;
        if (
          !result ||
          typeof result !== "object" ||
          Object.keys(result).sort().join(",") !== "number,url" ||
          !("number" in result) ||
          !Number.isSafeInteger(result.number) ||
          Number(result.number) < 1 ||
          !("url" in result) ||
          typeof result.url !== "string" ||
          result.url.toLowerCase() !==
            `https://github.com/${row.repository}/pull/${result.number}`.toLowerCase()
        )
          throw new Error("publication_result_invalid");
        this.store.database
          .prepare(
            "UPDATE cell_publications SET state='complete',result=?,error_code=NULL WHERE task_id=? AND revision=? AND state='pushed'",
          )
          .run(JSON.stringify(result), row.task_id, row.revision);
      } catch {
        if (this.current(row))
          this.store.database
            .prepare(
              "UPDATE cell_publications SET error_code='github_unavailable' WHERE task_id=? AND revision=? AND state='pushed'",
            )
            .run(row.task_id, row.revision);
      }
    }
    if (!this.isActive()) return false;
    return !!this.store.database
      .prepare("SELECT task_id FROM cell_publications WHERE state IN ('pending','pushed') LIMIT 1")
      .get();
  }
}
