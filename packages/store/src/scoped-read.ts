import type { EntityKind } from "@zoltbot/protocol";
import type { SqlDriver } from "./driver.js";
import type { Snapshot } from "./store.js";

export type ReadScope =
  | { projectId: string; taskId?: never }
  | { taskId: string; projectId?: never };

/** Load owned rows through indexed lookups, then add only their referenced parent records. */
export function scopedRead(database: SqlDriver, scope: ReadScope): Snapshot {
  const project = "projectId" in scope && scope.projectId !== undefined;
  const id = project ? scope.projectId : scope.taskId;
  if (!id || typeof id !== "string" || (scope.projectId && scope.taskId))
    throw new Error("invalid_read_scope");
  const column = project ? "projectId" : "taskId";
  const threads = project
    ? "SELECT id FROM threads WHERE project_id=?"
    : "SELECT id FROM threads WHERE task_id=? UNION SELECT thread_id FROM tasks WHERE id=?";
  const threadBindings = project ? [id] : [id, id];
  const rows = database
    .prepare(`
    WITH scoped_threads AS (${threads}), scoped_messages AS (
      SELECT id FROM messages WHERE thread_id IN (SELECT id FROM scoped_threads)
      UNION SELECT id FROM messages WHERE task_id IN (SELECT id FROM tasks WHERE ${project ? "project_id" : "id"}=?)
    )
    SELECT kind,id FROM projection_rows WHERE kind=? AND id=?
    UNION SELECT kind,id FROM projection_rows WHERE json_extract(body,'$.${column}')=?
    UNION SELECT kind,id FROM projection_rows WHERE kind='thread' AND id IN (SELECT id FROM scoped_threads)
    UNION SELECT kind,id FROM projection_rows WHERE json_extract(body,'$.threadId') IN (SELECT id FROM scoped_threads)
    UNION SELECT kind,id FROM projection_rows WHERE kind='message' AND id IN (SELECT id FROM scoped_messages)
    UNION SELECT p.kind,p.id FROM projection_rows p WHERE p.kind='delivery'
      AND p.id IN (SELECT id FROM deliveries WHERE message_id IN (SELECT id FROM scoped_messages))
    UNION SELECT kind,id FROM projection_rows WHERE json_extract(body,'$.scope.type')=? AND json_extract(body,'$.scope.id')=?
    ORDER BY kind,id
  `)
    .all(
      ...threadBindings,
      id,
      project ? "project" : "task",
      id,
      id,
      project ? "project" : "task",
      id,
    ) as { kind: EntityKind; id: string; body: string }[];
  const state: Snapshot = {};
  const seen = new Set<string>();
  const add = (kind: EntityKind, recordId: unknown) => {
    if (typeof recordId !== "string" || seen.has(`${kind}:${recordId}`)) return;
    const row = database
      .prepare("SELECT body FROM projection_records WHERE kind=? AND id=?")
      .get(kind, recordId) as { body: string } | undefined;
    if (row) append(kind, JSON.parse(row.body), recordId);
  };
  const append = (kind: EntityKind, body: Record<string, unknown>, recordId: string) => {
    const key = `${kind}:${recordId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const entries = state[kind] ?? [];
    entries.push(body);
    state[kind] = entries;
    // These are references to shared configuration, not permission to read other tasks.
    add("project", body.projectId);
    add("agent", body.agentId ?? body.ownerAgentId);
    add("agentDefinition", body.definitionId);
    add("workspace", body.workspaceId);
    add("subproject", body.subprojectId);
    add("area", body.areaId);
    add("initiative", body.initiativeId);
    add("initiativeRecord", body.initiativeId);
  };
  for (const row of rows) add(row.kind, row.id);
  return state;
}
